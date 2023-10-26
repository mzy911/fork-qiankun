/**
 * @author Kuitos
 * @since 2019-04-11
 */

import { isFunction, noop } from 'lodash';

// g_history umi中的全局变量
// 修复 umi 中卸载时的问题
export default function patch() {
  let rawHistoryListen = (_: any) => noop;
  const historyListeners: Array<typeof noop> = [];
  const historyUnListens: Array<typeof noop> = [];

  if ((window as any).g_history && isFunction((window as any).g_history.listen)) {
    rawHistoryListen = (window as any).g_history.listen.bind((window as any).g_history);

    (window as any).g_history.listen = (listener: typeof noop) => {
      historyListeners.push(listener);

      const unListen = rawHistoryListen(listener);
      historyUnListens.push(unListen);

      return () => {
        unListen();
        historyUnListens.splice(historyUnListens.indexOf(unListen), 1);
        historyListeners.splice(historyListeners.indexOf(listener), 1);
      };
    };
  }

  return function free() {
    let rebuild = noop;

    // 执行余量 listener
    // 1、应用在 unmout 时未正确卸载 listener
    // 2、listener 是应用 mount 之前绑定的，在下次 mount 之前需重新绑定该 listener
    if (historyListeners.length) {
      rebuild = () => {
        historyListeners.forEach((listener) => (window as any).g_history.listen(listener));
      };
    }

    // 卸载余下的 listener
    historyUnListens.forEach((unListen) => unListen());

    // restore
    if ((window as any).g_history && isFunction((window as any).g_history.listen)) {
      (window as any).g_history.listen = rawHistoryListen;
    }

    return rebuild;
  };
}
