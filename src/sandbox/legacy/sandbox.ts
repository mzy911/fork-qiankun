/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { SandBox } from '../../interfaces';
import { SandBoxType } from '../../interfaces';
import { getTargetValue } from '../common';

function isPropConfigurable(target: WindowProxy, prop: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);
  return descriptor ? descriptor.configurable : true;
}

/**
 * 基于 Proxy 实现的沙箱
 * TODO: 为了兼容性 singular 模式下依旧使用该沙箱，等新沙箱稳定之后再切换
 */
export default class LegacySandbox implements SandBox {
  // 新增的变量
  private addedPropsMapInSandbox = new Map<PropertyKey, any>();

  // 更新的变量
  private modifiedPropsOriginalValueMapInSandbox = new Map<PropertyKey, any>();

  // 记录全部新增和修改的变量
  private currentUpdatedPropsValueMap = new Map<PropertyKey, any>();

  name: string;

  proxy: WindowProxy; // proxy 拦截器

  // 保存全局属性
  globalContext: typeof window;

  type: SandBoxType;

  sandboxRunning = true;

  // 记录最后更新的属性 key
  latestSetProp: PropertyKey | null = null;

  // 设置、删除 globalContext 的属性值
  private setWindowProp(prop: PropertyKey, value: any, toDelete?: boolean) {
    if (value === undefined && toDelete) {
      // 删除属性
      delete (this.globalContext as any)[prop];
    } else if (isPropConfigurable(this.globalContext, prop) && typeof prop !== 'symbol') {
      // 设置属性
      Object.defineProperty(this.globalContext, prop, { writable: true, configurable: true });
      (this.globalContext as any)[prop] = value;
    }
  }

  // 启动沙箱 - 重置 globalContext
  active() {
    if (!this.sandboxRunning) {
      this.currentUpdatedPropsValueMap.forEach((v, p) => this.setWindowProp(p, v));
    }

    this.sandboxRunning = true;
  }

  // 关闭沙箱 - 重置 globalContext
  inactive() {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
        ...this.addedPropsMapInSandbox.keys(),
        ...this.modifiedPropsOriginalValueMapInSandbox.keys(),
      ]);
    }

    // renderSandboxSnapshot = snapshot(currentUpdatedPropsValueMapForSnapshot);
    this.modifiedPropsOriginalValueMapInSandbox.forEach((v, p) => this.setWindowProp(p, v));
    this.addedPropsMapInSandbox.forEach((_, p) => this.setWindowProp(p, undefined, true));

    this.sandboxRunning = false;
  }

  constructor(name: string, globalContext = window) {
    this.name = name;
    this.globalContext = globalContext;
    this.type = SandBoxType.LegacyProxy;
    const {
      addedPropsMapInSandbox,
      modifiedPropsOriginalValueMapInSandbox,
      currentUpdatedPropsValueMap,
    } = this;

    const rawWindow = globalContext;
    const fakeWindow = Object.create(null) as Window;

    // 设置属性
    const setTrap = (p: PropertyKey, value: any, originalValue: any, sync2Window = true) => {
      // 运行中才可以设置值
      if (this.sandboxRunning) {
        if (!rawWindow.hasOwnProperty(p)) {
          // rawWindow 上不存在 p 属性
          addedPropsMapInSandbox.set(p, value);
        } else if (!modifiedPropsOriginalValueMapInSandbox.has(p)) {
          // 沙箱更新期间不存在
          modifiedPropsOriginalValueMapInSandbox.set(p, originalValue);
        }

        // 记录全部变更的值
        currentUpdatedPropsValueMap.set(p, value);

        // 必须重新设置 window 对象保证下次 get 时能拿到已更新的数据
        if (sync2Window) {
          (rawWindow as any)[p] = value;
        }

        // 最后更新的属性
        this.latestSetProp = p;

        return true;
      }

      if (process.env.NODE_ENV === 'development') {
        console.warn(
          `[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`,
        );
      }

      // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError
      // 在沙箱卸载的情况下应该忽略错误
      return true;
    };

    const proxy = new Proxy(fakeWindow, {
      // 设置属性值
      set: (_: Window, p: PropertyKey, value: any): boolean => {
        const originalValue = (rawWindow as any)[p];
        return setTrap(p, value, originalValue, true);
      },

      // 获取属性值
      get(_: Window, p: PropertyKey): any {
        if (p === 'top' || p === 'parent' || p === 'window' || p === 'self') {
          return proxy;
        }
        const value = (rawWindow as any)[p];
        return getTargetValue(rawWindow, value);
      },

      // 是否包含某属性
      has(_: Window, p: string | number | symbol): boolean {
        return p in rawWindow;
      },

      // 获取属性描述
      getOwnPropertyDescriptor(_: Window, p: PropertyKey): PropertyDescriptor | undefined {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
        if (descriptor && !descriptor.configurable) {
          descriptor.configurable = true;
        }
        return descriptor;
      },

      // 新增属性
      defineProperty(_: Window, p: string | symbol, attributes: PropertyDescriptor): boolean {
        const originalValue = (rawWindow as any)[p];
        const done = Reflect.defineProperty(rawWindow, p, attributes);
        const value = (rawWindow as any)[p];
        setTrap(p, value, originalValue, false);

        return done;
      },
    });

    this.proxy = proxy;
  }

  patchDocument(): void {}
}
