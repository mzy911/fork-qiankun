/**
 * @author dbkillerf6
 * @since 2020-04-10
 */

import { cloneDeep } from 'lodash';
import type { OnGlobalStateChangeCallback, MicroAppStateActions } from './interfaces';

// 全局 State
let globalState: Record<string, any> = {};
const deps: Record<string, OnGlobalStateChangeCallback> = {};

// 全局 State 更新、执行 deps 回调
function emitGlobal(state: Record<string, any>, prevState: Record<string, any>) {
  Object.keys(deps).forEach((id: string) => {
    if (deps[id] instanceof Function) {
      deps[id](cloneDeep(state), cloneDeep(prevState));
    }
  });
}

// 初始化 State
export function initGlobalState(state: Record<string, any> = {}) {
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[qiankun] globalState tools will be removed in 3.0, pls don't use it!`);
  }

  if (state === globalState) {
    console.warn('[qiankun] state has not changed！');
  } else {
    const prevGlobalState = cloneDeep(globalState);
    globalState = cloneDeep(state);

    // 触发全局监听(不执行、未注册)
    emitGlobal(globalState, prevGlobalState);
  }

  // 返回通信方法
  return getMicroAppStateActions(`global-${+new Date()}`, true);
}

// 返回通信方法（监听、设置、注销）
export function getMicroAppStateActions(id: string, isMaster?: boolean): MicroAppStateActions {
  return {
    // deps 中添加回调
    onGlobalStateChange(callback: OnGlobalStateChangeCallback, fireImmediately?: boolean) {
      // 回调函数必须为 function
      if (!(callback instanceof Function)) {
        console.error('[qiankun] callback must be function!');
        return;
      }

      // 如果回调函数已经存在，重复注册时给出覆盖提示信息
      if (deps[id]) {
        console.warn(`[qiankun] '${id}' global listener already exists before this, new listener will overwrite it.`);
      }

      // id 为一个应用 id
      deps[id] = callback;

      // 立即出发回调执行
      if (fireImmediately) {
        const cloneState = cloneDeep(globalState);
        callback(cloneState, cloneState);
      }
    },

    /**
     * setGlobalState：按一级属性设置全局状态
     * 1. 对新输入 state 的第一层属性做校验，如果是主应用则可以添加新的一级属性进来，也可以更新已存在的一级属性，
     *    如果是微应用，则只能更新已存在的一级属性，不可以新增一级属性
     * 2. 触发全局监听，执行所有应用注册的回调函数，以达到应用间通信的目的
     */
    setGlobalState(state: Record<string, any> = {}) {
      if (state === globalState) {
        console.warn('[qiankun] state has not changed！');
        return false;
      }

      // 记录旧的全局状态中被改变的 key
      const changeKeys: string[] = [];
      // 旧的全局状态
      const prevGlobalState = cloneDeep(globalState);

      globalState = cloneDeep(
        // 循环遍历新状态中的所有 key
        Object.keys(state).reduce((_globalState, changeKey) => {
          // 主应用 或者 旧的全局状态存在该 key 时才进来
          if (isMaster || _globalState.hasOwnProperty(changeKey)) {
            // 记录被改变的key
            changeKeys.push(changeKey);
            // 更新旧状态中对应的 key value
            return Object.assign(_globalState, { [changeKey]: state[changeKey] });
          }
          console.warn(`[qiankun] '${changeKey}' not declared when init state！`);
          return _globalState;
        }, globalState),
      );

      if (changeKeys.length === 0) {
        console.warn('[qiankun] state has not changed！');
        return false;
      }

      // 触发监听
      emitGlobal(globalState, prevGlobalState);
      return true;
    },

    // 注销该应用下的依赖
    offGlobalStateChange() {
      delete deps[id];
      return true;
    },
  };
}
