/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { Freer, Rebuilder, SandBox } from '../interfaces';
import LegacySandbox from './legacy/sandbox';
import { patchAtBootstrapping, patchAtMounting } from './patchers';
import ProxySandbox from './proxySandbox';
import SnapshotSandbox from './snapshotSandbox';

export { getCurrentRunningApp } from './common';
export { css } from './patchers';

// 生成应用运行时沙箱
export function createSandboxContainer(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  scopedCSS: boolean,
  useLooseSandbox?: boolean, // 使用松散沙箱
  excludeAssetFilter?: (url: string) => boolean,
  globalContext?: typeof window,
  speedySandBox?: boolean,
) {
  // 一共三种沙箱
  // 1、LegacySandbox、ProxySandbox 依赖 window.Proxy
  // 2、SnapshotSandbox 用于单列模式
  let sandbox: SandBox;
  if (window.Proxy) {
    sandbox = useLooseSandbox
      ? new LegacySandbox(appName, globalContext)
      : new ProxySandbox(appName, globalContext, { speedy: !!speedySandBox });
  } else {
    sandbox = new SnapshotSandbox(appName);
  }

  // 初始化
  const bootstrappingFreers = patchAtBootstrapping(
    appName,
    elementGetter,
    sandbox,
    scopedCSS,
    excludeAssetFilter,
    speedySandBox,
  );
  // 挂载自由器是一次性的，应该在每次挂载时重新初始化
  let mountingFreers: Freer[] = [];
  let sideEffectsRebuilders: Rebuilder[] = [];

  return {
    instance: sandbox,

    // 挂载沙箱
    async mount() {
      // 1. 启动/恢复 沙箱
      sandbox.active();

      const sideEffectsRebuildersAtBootstrapping = sideEffectsRebuilders.slice(
        0,
        bootstrappingFreers.length,
      );
      const sideEffectsRebuildersAtMounting = sideEffectsRebuilders.slice(
        bootstrappingFreers.length,
      );

      // 必须先重建启动时增加的副作用才能恢复到自然状态吗
      if (sideEffectsRebuildersAtBootstrapping.length) {
        sideEffectsRebuildersAtBootstrapping.forEach((rebuild) => rebuild());
      }

      // 2. 开启全局变量补丁
      // render 沙箱启动时开始劫持各类全局监听，尽量不要在应用初始化阶段有 事件监听/定时器 等副作用
      mountingFreers = patchAtMounting(
        appName,
        elementGetter,
        sandbox,
        scopedCSS,
        excludeAssetFilter,
        speedySandBox,
      );

      // 3. 重置一些初始化时的副作用
      if (sideEffectsRebuildersAtMounting.length) {
        sideEffectsRebuildersAtMounting.forEach((rebuild) => rebuild());
      }

      // 清理重建者
      sideEffectsRebuilders = [];
    },

    // 下载沙箱
    async unmount() {
      // 记录窗口副作用的重建者
      // 请注意，挂载阶段的释放是一次性的，因为它将在下一次挂载时重新初始化
      sideEffectsRebuilders = [...bootstrappingFreers, ...mountingFreers].map((free) => free());

      sandbox.inactive();
    },
  };
}
