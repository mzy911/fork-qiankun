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
export { initGlobalState } from './globalState';
export { getCurrentRunningApp as __internalGetCurrentRunningApp } from './sandbox';
export * from './errorHandler';
export * from './effects';
export * from './interfaces';
export { prefetchImmediately as prefetchApps } from './prefetch';
