import { noop } from 'lodash';
import type { ParcelConfigObject } from 'single-spa';
import { mountRootParcel, registerApplication, start as startSingleSpa } from 'single-spa';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  LoadableApp,
  MicroApp,
  ObjectType,
  RegistrableApp,
} from './interfaces';
import type { ParcelConfigObjectGetter } from './loader';
import { loadApp } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainerXPath, isConstDestructAssignmentSupported, toArray } from './utils';

let microApps: Array<RegistrableApp<Record<string, unknown>>> = [];

export let frameworkConfiguration: FrameworkConfiguration = {};

let started = false;
const defaultUrlRerouteOnly = true;

// 返回一个Promise"对象"
const frameworkStartedDefer = new Deferred<void>();

// 自动降级低版本浏览器
const autoDowngradeForLowVersionBrowser = (configuration: FrameworkConfiguration): FrameworkConfiguration => {
  const { sandbox = true, singular } = configuration;
  if (sandbox) {
    if (!window.Proxy) {
      console.warn('[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox');

      // 快照沙箱不支持非 singular 模式
      if (singular === false) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        );
      }

      return { ...configuration, sandbox: typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true } };
    }

    if (
      !isConstDestructAssignmentSupported() &&
      (sandbox === true || (typeof sandbox === 'object' && sandbox.speedy !== false))
    ) {
      console.warn(
        '[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!',
      );

      return {
        ...configuration,
        sandbox: typeof sandbox === 'object' ? { ...sandbox, speedy: false } : { speedy: false },
      };
    }
  }

  return configuration;
};

/**
 * 注册微应用，基于路由配置
 * @param apps = [
 *  {
 *    name: 'react16',
 *    entry: '//localhost:7100',
 *    container: '#subapp-viewport',
 *    loader,
 *    activeRule: '/react16'
 *  },
 *  ...
 * ]
 * @param lifeCycles = { ...各个生命周期方法对象 }
 */
export function registerMicroApps<T extends ObjectType>(
  apps: Array<RegistrableApp<T>>,
  lifeCycles?: FrameworkLifeCycles<T>,
) {
  // 防止微应用重复注册，得到所有没有被注册的微应用列表
  const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));
  microApps = [...microApps, ...unregisteredApps];

  // 注册每一个微应用
  unregisteredApps.forEach((app) => {
    const { name, activeRule, loader = noop, props, ...appConfig } = app;

    // 调用 single-spa 的 registerApplication 方法注册微应用
    registerApplication({
      name,
      // 微应用的加载方法，Promise<生命周期方法组成的对象>
      app: async () => {
        loader(true);

        // 目的是在 single-spa 执行这个加载方法时让出线程，让其它微应用的加载方法都开始执行
        await frameworkStartedDefer.promise;

        // 核心：负责加载微应用，返回 bootstrap、mount、unmount、update 生命周期
        // frameworkConfiguration：start 方法执行时设置的配置对象
        const { mount, ...otherMicroAppConfigs } = (
          await loadApp({ name, props, ...appConfig }, frameworkConfiguration, lifeCycles)
        )();

        return {
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        };
      },
      // 微应用的激活条件
      activeWhen: activeRule,
      // 传递给微应用的 props
      customProps: props,
    });
  });
}

const appConfigPromiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>();
const containerMicroAppsMap = new Map<string, MicroApp[]>();

/**
 * 手动加载一个微应用，是通过 single-spa 的 mountRootParcel api 实现的，返回微应用实例
 * @param app = { name, entry, container, props }
 * @param configuration 配置对象
 * @param lifeCycles 还支持一个全局生命周期配置对象，这个参数官方文档没提到
 */
export function loadMicroApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration & { autoStart?: boolean },
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const { props, name } = app;

  const container = 'container' in app ? app.container : undefined;
  // 必须在开始时计算容器xpath以保持其围绕应用程序运行吗
  // 如果我们每次都计算它，则容器dom结构很可能被更改，从而产生不同的xpath值
  const containerXPath = getContainerXPath(container);
  const appContainerXPathKey = `${name}-${containerXPath}`;

  let microApp: MicroApp;
  const wrapParcelConfigForRemount = (config: ParcelConfigObject): ParcelConfigObject => {
    let microAppConfig = config;
    if (container) {
      if (containerXPath) {
        const containerMicroApps = containerMicroAppsMap.get(appContainerXPathKey);
        if (containerMicroApps?.length) {
          const mount = [
            async () => {
              // 虽然在同一个容器上挂载了多个微应用程序，但我们必须等到前面的实例都卸载了，否则会导致一些并发问题
              const prevLoadMicroApps = containerMicroApps.slice(0, containerMicroApps.indexOf(microApp));
              const prevLoadMicroAppsWhichNotBroken = prevLoadMicroApps.filter(
                (v) => v.getStatus() !== 'LOAD_ERROR' && v.getStatus() !== 'SKIP_BECAUSE_BROKEN',
              );
              await Promise.all(prevLoadMicroAppsWhichNotBroken.map((v) => v.unmountPromise));
            },
            ...toArray(microAppConfig.mount),
          ];

          microAppConfig = {
            ...config,
            mount,
          };
        }
      }
    }

    return {
      ...microAppConfig,
      // 空的引导钩子，当它从缓存的微应用调用时不应该运行两次
      bootstrap: () => Promise.resolve(),
    };
  };

  /**
   * 将名称容器xpath作为微应用实例id，这意味着如果你将一个微应用渲染到一个之前已经渲染过的dom，这个微应用将不会再次加载生命周期
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const userConfiguration = autoDowngradeForLowVersionBrowser(
      configuration ?? { ...frameworkConfiguration, singular: false },
    );
    const { $$cacheLifecycleByAppName } = userConfiguration;

    if (container) {
      // using appName as cache for internal experimental scenario
      if ($$cacheLifecycleByAppName) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }

      if (containerXPath) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(appContainerXPathKey);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }
    }

    const parcelConfigObjectGetterPromise = loadApp(app, userConfiguration, lifeCycles);

    if (container) {
      if ($$cacheLifecycleByAppName) {
        appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);
      } else if (containerXPath) appConfigPromiseGetterMap.set(appContainerXPathKey, parcelConfigObjectGetterPromise);
    }

    return (await parcelConfigObjectGetterPromise)(container);
  };

  if (!started && configuration?.autoStart !== false) {
    // 我们需要调用single-spa的start方法，因为popstate事件应该在主应用自动调用pushState/replaceState时被分派，但在single-spa中，它会在分派popstate之前检查启动状态
    // see https://github.com/single-spa/single-spa/blob/f28b5963be1484583a072c8145ac0b5a28d91235/src/navigation/navigation-events.js#L101
    // ref https://github.com/umijs/qiankun/pull/1071
    startSingleSpa({ urlRerouteOnly: frameworkConfiguration.urlRerouteOnly ?? defaultUrlRerouteOnly });
  }

  microApp = mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });

  if (container) {
    if (containerXPath) {
      // Store the microApps which they mounted on the same container
      const microAppsRef = containerMicroAppsMap.get(appContainerXPathKey) || [];
      microAppsRef.push(microApp);
      containerMicroAppsMap.set(appContainerXPathKey, microAppsRef);

      const cleanup = () => {
        const index = microAppsRef.indexOf(microApp);
        microAppsRef.splice(index, 1);
        // @ts-ignore
        microApp = null;
      };

      // gc after unmount
      microApp.unmountPromise.then(cleanup).catch(cleanup);
    }
  }

  return microApp;
}

export function start(opts: FrameworkConfiguration = {}) {
  // 框架默认开启预加载、单例模式、样式沙箱
  frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts };

  // 从这里可以看出 start 方法支持的参数不止官网文档说的那些，比如 urlRerouteOnly，这个是 single-spa 的 start 方法支持的
  const { prefetch, urlRerouteOnly = defaultUrlRerouteOnly, ...importEntryOpts } = frameworkConfiguration;

  if (prefetch) {
    // 执行预加载策略
    doPrefetchStrategy(microApps, prefetch, importEntryOpts);
  }

  // 自动降级低版本浏览器
  frameworkConfiguration = autoDowngradeForLowVersionBrowser(frameworkConfiguration);

  // 执行 single-spa 的 start 方法，启动 single-spa
  startSingleSpa({ urlRerouteOnly });
  started = true;

  frameworkStartedDefer.resolve();
}
