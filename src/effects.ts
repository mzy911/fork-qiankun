/**
 * @author Kuitos
 * @since 2019-02-19
 */
import { getMountedApps, navigateToUrl } from 'single-spa';

const firstMountLogLabel = '[qiankun] first app mounted';
if (process.env.NODE_ENV === 'development') {
  console.time(firstMountLogLabel);
}

/**
 * 1、设置主应用启动后默认进入的微应用
 * 2、该事件在所有微应用状态改变结束后（即发生路由切换且新的微应用已经被挂载完成）触发
 * @param defaultAppLink 微应用的链接，比如 /react16
 */
export function setDefaultMountApp(defaultAppLink: string) {
  // 利用的是 single-spa 的 single-spa:no-app-change 事件
  window.addEventListener('single-spa:no-app-change', function listener() {
    // 说明微应用已经挂载完成，获取挂载的微应用列表，再次确认确实有微应用挂载了
    const mountedApps = getMountedApps();
    if (!mountedApps.length) {
      navigateToUrl(defaultAppLink);
    }

    // 触发一次以后，就移除该事件的监听函数
    window.removeEventListener('single-spa:no-app-change', listener);
  });
}

// 这个 api 和 setDefaultMountApp 作用一致，官网也提到，兼容老版本的一个 api
export function runDefaultMountEffects(defaultAppLink: string) {
  console.warn(
    '[qiankun] runDefaultMountEffects will be removed in next version, please use setDefaultMountApp instead',
  );
  setDefaultMountApp(defaultAppLink);
}

/**
 * 1、第一个微应用 mount 后需要调用的方法
 * 2、比如开启一些监控或者埋点脚本
 * @param effect 回调函数，当第一个微应用挂载以后要做的事情
 */
export function runAfterFirstMounted(effect: () => void) {
  // 利用的 single-spa 的 single-spa:first-mount 事件
  window.addEventListener('single-spa:first-mount', function listener() {
    if (process.env.NODE_ENV === 'development') {
      console.timeEnd(firstMountLogLabel);
    }

    effect();

    // 这里不移除也没事，因为这个事件后续不会再被触发了
    window.removeEventListener('single-spa:first-mount', listener);
  });
}
