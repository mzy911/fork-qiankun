/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import type { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import type { FrameworkConfiguration, FrameworkLifeCycles, HTMLContentRender, LifeCycleFn, LoadableApp, ObjectType } from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import { cachedGlobals } from './sandbox/proxySandbox';
import {
  Deferred,
  genAppInstanceIdByName,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceGetEntriesByName,
  performanceMark,
  performanceMeasure,
  toArray,
  validateExportLifecycle,
} from './utils';

// 元素是否存在
function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new QiankunError(msg);
    }

    throw new QiankunError('element not existed!');
  }
}

// 执行回调函数链
function execHooksChain<T extends ObjectType>(hooks: Array<LifeCycleFn<T>>, app: LoadableApp<T>, global = window): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

// 验证是否微单一模式
async function validateSingularMode<T extends ObjectType>(validate: FrameworkConfiguration['singular'], app: LoadableApp<T>): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

const supportShadowDOM = !!document.head.attachShadow || !!(document.head as any).createShadowRoot;

/**
 * 创建 Element、a：利用 attachShadow 样式隔离 b：setAttribute(css.QiankunCSSRewriteAttr, appInstanceId)
 *  1、将 appContent 由字符串模版转换成 html dom 元素
 *  2、如果需要开启严格样式隔离，则将 appContent 的子元素即微应用的入口模版用 shadow dom 包裹起来，达到样式严格隔离的目的
 * @param appContent = `<div id="__qiankun_microapp_wrapper_for_${appInstanceId}__" data-name="${appName}">${template}</div>`
 * @param strictStyleIsolation 是否开启严格样式隔离
 * @param scopedCSS 实验性的样式隔离，如果开启了严格样式隔离，则 scoped css 就为 false
 */
function createElement(appContent: string, strictStyleIsolation: boolean, scopedCSS: boolean, appInstanceId: string): HTMLElement {
  // 创建一个 div 元素
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  const appElement = containerElement.firstChild as HTMLElement;

  // 如果开启了严格的样式隔离（以达到微应用之间样式严格隔离的目的）
  if (strictStyleIsolation) {
    // 利用 ShadowDOM 隔离外部环境用于封装组件
    if (!supportShadowDOM) {
      console.warn('[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!');
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';

      // 沙箱模型：利用 Element.attachShadow()
      let shadow: ShadowRoot;

      // 支持 attachShadow
      if (appElement.attachShadow) {
        // 给指定的元素挂载一个 Shadow DOM，并且返回对 ShadowRoot 的引用。
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // 不支持：attachShadow
        // createShadowRoot是在最初的规范中提出的，后来被弃用了
        shadow = (appElement as any).createShadowRoot();
      }

      shadow.innerHTML = innerHTML;
    }
  }

  if (scopedCSS) {
    // 给 appElement 设置 'data-qiankun' 属性
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) {
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appInstanceId);
    }

    const styleNodes = appElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appInstanceId);
    });
  }

  return appElement;
}

// 获取 App 外层容器
function getAppWrapperGetter(appInstanceId: string, useLegacyRender: boolean, strictStyleIsolation: boolean, scopedCSS: boolean, elementGetter: () => HTMLElement | null) {
  return () => {
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');

      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(appWrapper, `Wrapper element for ${appInstanceId} is not existed!`);
      // "!" 非空断言
      return appWrapper!;
    }

    const element = elementGetter();
    assertElementExist(element, `Wrapper element for ${appInstanceId} is not existed!`);

    if (strictStyleIsolation && supportShadowDOM) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement }, phase: 'loading' | 'mounting' | 'mounted' | 'unmounted') => any;

/**
 * 获取渲染函数、插入元素
 * 1、如果提供了遗留渲染函数，就按原样使用
 * 2、否则我们将通过乾坤将app元素插入目标容器
 */
function getRender(appInstanceId: string, appContent: string, legacyRender?: HTMLContentRender) {
  const render: ElementRender = ({ element, loading, container }, phase) => {
    // 存在 legacyRender 遗留渲染函数
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[qiankun] Custom rendering function is deprecated and will be removed in 3.0, you can use the container element setting instead!');
      }

      // 使用 legacyRender 渲染 element
      return legacyRender({ loading, appContent: element ? appContent : '' });
    }

    const containerElement = getContainer(container!);

    // 容器可能在微应用卸载后被移除。
    // 比如由react componentWillUnmount生命周期调用的微应用卸载生命周期，在微应用卸载后，react组件也可能被移除
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `Target container with ${container} not existed while ${appInstanceId} ${phase}!`;

          case 'mounted':
            return `Target container with ${container} not existed after ${appInstanceId} ${phase}!`;

          default:
            return `Target container with ${container} not existed while ${appInstanceId} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }

    if (containerElement && !containerElement.contains(element)) {
      // 清除容器
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // 如果该元素存在，将其附加到容器中
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

// 获取生命周期的钩子函数
function getLifecyclesFromExports(scriptExports: LifeCycles<any>, appName: string, global: WindowProxy, globalLatestSetProp?: PropertyKey | null) {
  // 返回生命周期钩子函数
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // 回退到沙盒最新设置属性(如果有)
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(`[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`);
  }

  // 当模块导出未找到时，回退到以${appName}命名的全局变量
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

/**
 * 加载当前微应用 - 完成了以下几件事：
 *  1、通过 HTML Entry 的方式远程加载微应用，得到微应用的 html 模版（首屏内容）、JS 脚本执行器、静态经资源路径
 *  2、样式隔离，shadow DOM 或者 scoped css 两种方式
 *  3、渲染微应用
 *  4、运行时沙箱，JS 沙箱、样式沙箱
 *  5、合并沙箱传递出来的 生命周期方法、用户传递的生命周期方法、框架内置的生命周期方法，将这些生命周期方法统一整理，导出一个生命周期对象，
 *     供 single-spa 的 registerApplication 方法使用，这个对象就相当于使用 single-spa 时你的微应用导出的那些生命周期方法，只不过 qiankun
 *     额外填了一些生命周期方法，做了一些事情
 *  6、给微应用注册通信方法并返回通信方法，然后会将通信方法通过 props 注入到微应用
 * @param app 微应用配置对象
 * @param configuration start 方法执行时设置的配置对象
 * @param lifeCycles 注册微应用时提供的全局生命周期对象
 */
export async function loadApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  const { entry, name: appName } = app;

  // 根据 appName 返回应用对应的 idName
  const appInstanceId = genAppInstanceIdByName(appName);
  const markName = `[qiankun] App ${appInstanceId} Loading`;

  // 在 performance 上打标记
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  const { singular = false, sandbox = true, excludeAssetFilter, globalContext = window, ...importEntryOpts } = configuration;

  /**
   * 依赖 import-html-entry 第三方库，获取微应用的入口 html 内容和脚本执行器
   *  1、template 是 link 替换为 style 后的 template
   *  2、execScript 是 让 JS 代码(scripts)在指定 上下文 中运行
   *  3、assetPublicPath 是静态资源地址
   */
  const { template, execScripts, assetPublicPath, getExternalScripts } = await importEntry(entry, importEntryOpts);

  // 触发外部脚本加载，以确保在execScripts调用之前所有资产都准备好了
  await getExternalScripts();

  // single-spa 的限制，加载、初始化和卸载不能同时进行，
  // 必须等卸载完成以后才可以进行加载，这个 promise 会在微应用卸载完成后被 resolve，在后面可以看到
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }

  // 制作 Wrapper 包裹 appContent <div id="${getWrapperId( name )}
  const appContent = getDefaultTplWrapper(appInstanceId, sandbox)(template);

  // 是否严格样式隔离
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;

  if (process.env.NODE_ENV === 'development' && strictStyleIsolation) {
    console.warn("[qiankun] strictStyleIsolation configuration will be removed in 3.0, pls don't depend on it or use experimentalStyleIsolation instead!");
  }

  // 是否启动 scopedCSS 沙箱
  const scopedCSS = isEnableScopedCSS(sandbox);

  let initialAppWrapperElement: HTMLElement | null = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);

  const initialContainer = 'container' in app ? app.container : undefined;
  const legacyRender = 'render' in app ? app.render : undefined;

  // 获取渲染函数
  const render = getRender(appInstanceId, appContent, legacyRender);
  // 利用渲染函数插入新的 element 节点
  render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');

  const initialAppWrapperGetter = getAppWrapperGetter(appInstanceId, !!legacyRender, strictStyleIsolation, scopedCSS, () => initialAppWrapperElement);

  let global = globalContext;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;

  // 默认开启 speedy 模式
  const speedySandbox = typeof sandbox === 'object' ? sandbox.speedy !== false : true;
  let sandboxContainer;

  // 制作沙箱容器
  if (sandbox) {
    sandboxContainer = createSandboxContainer(appInstanceId, initialAppWrapperGetter, scopedCSS, useLooseSandbox, excludeAssetFilter, global, speedySandbox);
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window;
    mountSandbox = sandboxContainer.mount;
    unmountSandbox = sandboxContainer.unmount;
  }

  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = [],
  } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

  await execHooksChain(toArray(beforeLoad), app, global);

  // 从模块导出中获取生命周期钩子
  const scriptExports: any = await execScripts(global, sandbox && !useLooseSandbox, {
    scopedGlobalVariables: speedySandbox ? cachedGlobals : [],
  });
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(scriptExports, appName, global, sandboxContainer?.instance?.latestSetProp);

  // 监听、设置 全局State
  const { onGlobalStateChange, setGlobalState, offGlobalStateChange }: Record<string, CallableFunction> = getMicroAppStateActions(appInstanceId);

  // FIXME temporary way
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  // 返回 parcelConfigGetter
  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null;
    let appWrapperGetter: ReturnType<typeof getAppWrapperGetter>;

    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performanceGetEntriesByName(markName, 'mark');
            // 标记长度为零表示应用程序正在重新加载
            if (marks && !marks.length) {
              performanceMark(markName);
            }
          }
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // 应用挂载/重新挂载前的初始包装器元素
        async () => {
          appWrapperElement = initialAppWrapperElement;
          appWrapperGetter = getAppWrapperGetter(appInstanceId, !!legacyRender, strictStyleIsolation, scopedCSS, () => appWrapperElement);
        },

        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // 元素在卸载后将被销毁，如果它不存在，我们需要重新创建它，或者我们尝试重新挂载到一个新的容器中
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }

          render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
        },
        mountSandbox,
        // 在渲染后执行链以保持beforeLoad的行为
        async () => execHooksChain(toArray(beforeMount), app, global),
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),

        // 安装应用程序后完成加载
        async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
        async () => execHooksChain(toArray(afterMount), app, global),

        // 在app挂载后初始化unmount defer，并在app卸载后解析这个defer
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        async () => execHooksChain(toArray(beforeUnmount), app, global),
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        unmountSandbox,
        async () => execHooksChain(toArray(afterUnmount), app, global),
        async () => {
          render({ element: null, loading: false, container: remountContainer }, 'unmounted');
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}
