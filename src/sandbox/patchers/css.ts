/**
 * @author Saviio
 * @since 2020-4-19
 */

// https://developer.mozilla.org/en-US/docs/Web/API/CSSRule
enum RuleType {
  // type: 规则将被重写
  STYLE = 1,
  MEDIA = 4,
  SUPPORTS = 12,

  // type: 值将被保留
  IMPORT = 3,
  FONT_FACE = 5,
  PAGE = 6,
  KEYFRAMES = 7,
  KEYFRAME = 8,
}

const arrayify = <T>(list: CSSRuleList | any[]) => {
  return [].slice.call(list, 0) as T[];
};

/**
 * ScopedCSS
 * 1、接口提供了特殊的属性（除了它们继承的常规的HTMLElement接口）以外
 * 2、可以处理 body 元素
 */
const rawDocumentBodyAppend = HTMLBodyElement.prototype.appendChild;

// css 沙箱
export class ScopedCSS {
  private static ModifiedTag = 'Symbol(style-modified-qiankun)';
  private sheet: StyleSheet;
  private swapNode: HTMLStyleElement;

  constructor() {
    const styleNode = document.createElement('style');
    rawDocumentBodyAppend.call(document.body, styleNode);
    this.swapNode = styleNode;
    this.sheet = styleNode.sheet!;
    this.sheet.disabled = true;
  }

  /**
   * 拿到样式节点中的所有样式规则，然后重写样式选择器
   *  含有根元素选择器的情况：用前缀替换掉选择器中的根元素选择器部分，
   *  普通选择器：将前缀插到第一个选择器的后面
   *
   * 如果发现一个样式节点为空，则该节点的样式内容可能会被动态插入，qiankun 监控了该动态插入的样式，并做了同样的处理
   *
   * @param styleNode 样式节点
   * @param prefix 前缀 `div[data-qiankun]=${appName}`
   */
  process(styleNode: HTMLStyleElement, prefix: string = '') {
    // 样式节点不为空，即 <style>xx</style>
    if (ScopedCSS.ModifiedTag in styleNode) {
      return;
    }

    if (styleNode.textContent !== '') {
      // 创建一个文本节点，内容为 style 节点内的样式内容
      const textNode = document.createTextNode(styleNode.textContent || '');
      // swapNode 是 ScopedCss 类实例化时创建的一个空 style 节点，将样式内容添加到这个节点下
      this.swapNode.appendChild(textNode);
      const sheet = this.swapNode.sheet as any; // type is missing
      const rules = arrayify<CSSRule>(sheet?.cssRules ?? []);
      const css = this.rewrite(rules, prefix);
      // eslint-disable-next-line no-param-reassign
      styleNode.textContent = css;

      // cleanup
      this.swapNode.removeChild(textNode);
      (styleNode as any)[ScopedCSS.ModifiedTag] = true;
      return;
    }

    // 走到这里说明样式节点为空
    // 创建并返回一个新的 MutationObserver 它会在指定的DOM发生变化时被调用
    const mutator = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i += 1) {
        const mutation = mutations[i];

        // 表示该节点已经被 qiankun 处理过，后面就不会再被重复处理
        if (ScopedCSS.ModifiedTag in styleNode) {
          return;
        }

        // 如果是子节点列表发生变化
        if (mutation.type === 'childList') {
          // 拿到 styleNode 下的所有样式规则，并重写其样式选择器，然后用重写后的样式替换原有样式
          const sheet = styleNode.sheet as any;
          const rules = arrayify<CSSRule>(sheet?.cssRules ?? []);
          const css = this.rewrite(rules, prefix);

          // eslint-disable-next-line no-param-reassign
          styleNode.textContent = css;
          // eslint-disable-next-line no-param-reassign
          (styleNode as any)[ScopedCSS.ModifiedTag] = true;
        }
      }
    });

    // 观察 styleNode 节点，当其子节点发生变化时调用 callback 即 实例化时传递的函数
    // since observer will be deleted when node be removed
    // we dont need create a cleanup function manually
    // see https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/disconnect
    mutator.observe(styleNode, { childList: true });
  }

  /**
   * 重写样式选择器，都是在 ruleStyle 中处理的：
   *  含有根元素选择器的情况：用前缀替换掉选择器中的根元素选择器部分，
   *  普通选择器：将前缀插到第一个选择器的后面
   *
   * @param rules 样式规则
   * @param prefix 前缀 `div[data-qiankun]=${appName}`
   */
  private rewrite(rules: CSSRule[], prefix: string = '') {
    let css = '';

    // 几种类型的样式规则，所有类型查看
    rules.forEach((rule) => {
      switch (rule.type) {
        // 最常见的 selector { prop: val }
        case RuleType.STYLE:
          css += this.ruleStyle(rule as CSSStyleRule, prefix);
          break;
        // 媒体 @media screen and (max-width: 300px) { prop: val }
        case RuleType.MEDIA:
          css += this.ruleMedia(rule as CSSMediaRule, prefix);
          break;
        // @supports (display: grid) {}
        case RuleType.SUPPORTS:
          css += this.ruleSupport(rule as CSSSupportsRule, prefix);
          break;
        // 其它，直接返回样式内容
        default:
          if (typeof rule.cssText === 'string') {
            css += `${rule.cssText}`;
          }

          break;
      }
    });

    return css;
  }

  // handle case:
  // .app-main {}
  // html, body {}

  /**
   * 普通的根选择器用前缀代替
   * 根组合选择器置空，忽略非标准形式的兄弟选择器，比如 html + body {...}
   * 针对普通选择器则是在第一个选择器后面插入前缀，比如 .xx 变成 .xxprefix
   *
   * 总结就是：
   *  含有根元素选择器的情况：用前缀替换掉选择器中的根元素选择器部分，
   *  普通选择器：将前缀插到第一个选择器的后面
   *
   * handle case:
   * .app-main {}
   * html, body {}
   *
   * @param rule 比如：.app-main {} 或者 html, body {}
   * @param prefix `div[data-qiankun]=${appName}`
   */
  // eslint-disable-next-line class-methods-use-this
  private ruleStyle(rule: CSSStyleRule, prefix: string) {
    const rootSelectorRE = /((?:[^\w\-.#]|^)(body|html|:root))/gm;
    const rootCombinationRE = /(html[^\w{[]+)/gm;

    const selector = rule.selectorText.trim();

    let cssText = '';
    if (typeof rule.cssText === 'string') {
      cssText = rule.cssText;
    }

    // handle html { ... }
    // handle body { ... }
    // handle :root { ... }
    if (selector === 'html' || selector === 'body' || selector === ':root') {
      return cssText.replace(rootSelectorRE, prefix);
    }

    // handle html body { ... }
    // handle html > body { ... }
    if (rootCombinationRE.test(rule.selectorText)) {
      const siblingSelectorRE = /(html[^\w{]+)(\+|~)/gm;

      // since html + body is a non-standard rule for html
      // transformer will ignore it
      if (!siblingSelectorRE.test(rule.selectorText)) {
        cssText = cssText.replace(rootCombinationRE, '');
      }
    }

    // handle grouping selector, a,span,p,div { ... }
    cssText = cssText.replace(/^[\s\S]+{/, (selectors) =>
      selectors.replace(/(^|,\n?)([^,]+)/g, (item, p, s) => {
        // handle div,body,span { ... }
        if (rootSelectorRE.test(item)) {
          return item.replace(rootSelectorRE, (m) => {
            // do not discard valid previous character, such as body,html or *:not(:root)
            const whitePrevChars = [',', '('];

            if (m && whitePrevChars.includes(m[0])) {
              return `${m[0]}${prefix}`;
            }

            // replace root selector with prefix
            return prefix;
          });
        }

        return `${p}${prefix} ${s.replace(/^ */, '')}`;
      }),
    );

    return cssText;
  }

  // handle case:
  // @media screen and (max-width: 300px) {}
  private ruleMedia(rule: CSSMediaRule, prefix: string) {
    const css = this.rewrite(arrayify(rule.cssRules), prefix);
    return `@media ${rule.conditionText || rule.media.mediaText} {${css}}`;
  }

  // handle case:
  // @supports (display: grid) {}
  private ruleSupport(rule: CSSSupportsRule, prefix: string) {
    const css = this.rewrite(arrayify(rule.cssRules), prefix);
    return `@supports ${rule.conditionText || rule.cssText.split('{')[0]} {${css}}`;
  }
}

let processor: ScopedCSS;

export const QiankunCSSRewriteAttr = 'data-qiankun';

/**
 * 做了两件事：
 *  实例化 processor = new ScopedCss()，真正处理样式选择器的地方
 *  生成样式前缀 `div[data-qiankun]=${appName}`
 * @param appWrapper = <div id="__qiankun_microapp_wrapper_for_${appInstanceId}__" data-name="${appName}">${template}</div>
 * @param stylesheetElement = <style>xx</style>
 * @param appName 微应用名称
 */
export const process = (
  appWrapper: HTMLElement,
  stylesheetElement: HTMLStyleElement | HTMLLinkElement,
  appName: string,
): void => {
  // lazy singleton pattern，单例模式
  if (!processor) {
    processor = new ScopedCSS();
  }

  // 目前支持 style 标签
  if (stylesheetElement.tagName === 'LINK') {
    console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.');
  }

  // 微应用模版
  const mountDOM = appWrapper;
  if (!mountDOM) {
    return;
  }

  const tag = (mountDOM.tagName || '').toLowerCase();

  if (tag && stylesheetElement.tagName === 'STYLE') {
    // 生成前缀 `div[data-qiankun]=${appName}`
    const prefix = `${tag}[${QiankunCSSRewriteAttr}="${appName}"]`;

    /**
     * 实际处理样式的地方
     * 拿到样式节点中的所有样式规则，然后重写样式选择器
     *  含有根元素选择器的情况：用前缀替换掉选择器中的根元素选择器部分，
     *  普通选择器：将前缀插到第一个选择器的后面
     */
    processor.process(stylesheetElement, prefix);
  }
};
