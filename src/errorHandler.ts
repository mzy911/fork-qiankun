/**
 * @author Kuitos
 * @since 2020-02-21
 */

// single-spa 的异常捕获
export { addErrorHandler, removeErrorHandler } from 'single-spa';

// qiankun 的异常捕获
// 监听了 error 和 unhandlerejection 事件
export function addGlobalUncaughtErrorHandler(errorHandler: OnErrorEventHandlerNonNull): void {
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', errorHandler);
}

// 移除 error 和 unhandlerejection 事件监听
export function removeGlobalUncaughtErrorHandler(errorHandler: (...args: any[]) => any) {
  window.removeEventListener('error', errorHandler);
  window.removeEventListener('unhandledrejection', errorHandler);
}
