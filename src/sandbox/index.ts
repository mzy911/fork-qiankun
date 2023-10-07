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

/**
 * 生成应用运行时沙箱 - 沙箱分两个类型：
 * 1. app 环境沙箱：
 *    每个应用的环境沙箱只会初始化一次，因为子应用只会触发一次 bootstrap。
 *    子应用在切换时，实际上切换的是 app 环境沙箱。
 * 2. render 沙箱：
 *    子应用在 app mount 开始前生成好的的沙箱。
 *    每次子应用切换过后，render 沙箱都会重现初始化。
 * @param appName
 * @param elementGetter
 * @param scopedCSS
 * @param useLooseSandbox
 * @param excludeAssetFilter
 * @param globalContext
 * @param speedySandBox
 */
export function createSandboxContainer(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  scopedCSS: boolean,
  useLooseSandbox?: boolean,
  excludeAssetFilter?: (url: string) => boolean,
  globalContext?: typeof window,
  speedySandBox?: boolean,
) {
  let sandbox: SandBox;
  if (window.Proxy) {
    sandbox = useLooseSandbox
      ? new LegacySandbox(appName, globalContext)
      : new ProxySandbox(appName, globalContext, { speedy: !!speedySandBox });
  } else {
    sandbox = new SnapshotSandbox(appName);
  }

  // 在引导过程中可能会调用一些副作用，例如使用样式加载器进行动态样式表注入，特别是在开发阶段
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

    /**
     * 沙箱被 mount
     * 可能是从 bootstrap 状态进入的 mount
     * 也可能是从 unmount 之后再次唤醒进入 mount
     */
    async mount() {
      /* ------------------------------------------ 因为有上下文依赖（window），以下代码执行顺序不能变 ------------------------------------------ */
      /* ------------------------------------------ 1. 启动/恢复 沙箱------------------------------------------ */
      sandbox.active();

      const sideEffectsRebuildersAtBootstrapping = sideEffectsRebuilders.slice(0, bootstrappingFreers.length);
      const sideEffectsRebuildersAtMounting = sideEffectsRebuilders.slice(bootstrappingFreers.length);

      // 必须先重建启动时增加的副作用才能恢复到自然状态吗
      if (sideEffectsRebuildersAtBootstrapping.length) {
        sideEffectsRebuildersAtBootstrapping.forEach((rebuild) => rebuild());
      }

      /* ------------------------------------------ 2. 开启全局变量补丁 ------------------------------------------*/
      // render 沙箱启动时开始劫持各类全局监听，尽量不要在应用初始化阶段有 事件监听/定时器 等副作用
      mountingFreers = patchAtMounting(appName, elementGetter, sandbox, scopedCSS, excludeAssetFilter, speedySandBox);

      /* ------------------------------------------ 3. 重置一些初始化时的副作用 ------------------------------------------*/
      // 存在 rebuilder 则表明有些副作用需要重建
      if (sideEffectsRebuildersAtMounting.length) {
        sideEffectsRebuildersAtMounting.forEach((rebuild) => rebuild());
      }

      // 清理重建者
      sideEffectsRebuilders = [];
    },

    /**
     * 恢复 global 状态，使其能回到应用加载之前的状态
     */
    async unmount() {
      // 记录窗口副作用的重建者
      // 请注意，挂载阶段的释放是一次性的，因为它将在下一次挂载时重新初始化
      sideEffectsRebuilders = [...bootstrappingFreers, ...mountingFreers].map((free) => free());

      sandbox.inactive();
    },
  };
}
