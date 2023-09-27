/**
 * @author Kuitos
 * @since 2019-04-25
 */

/**
 * loadMicroApp：手动 加载/卸载 一个微应用
 * registerMicroApps：主应用批量注册微应用
 * start：主应用其实方法
 */
export { loadMicroApp, registerMicroApps, start } from './apis';

// 全局状态
export { initGlobalState } from './globalState';

// 沙箱
export { getCurrentRunningApp as __internalGetCurrentRunningApp } from './sandbox';

// 全局的未捕获异常处理器
export * from './errorHandler';

// 副作用函数：setDefaultMountApp 设置主应用启动后默认进入哪个微应用、runAfterFirstMounted 设置当第一个微应用挂载以后需要调用的一些方法
export * from './effects';

export * from './interfaces';
export { prefetchImmediately as prefetchApps } from './prefetch';
