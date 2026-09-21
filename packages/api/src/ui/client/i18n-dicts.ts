/**
 * 非 en locale 字典注册表（#137 B2）。
 * en 不设静态件——浏览器回落内嵌 I18N_EN；服务端壳填充亦仅在非 en 传 dict。
 */
import type { UiI18nFileLocale, UiLocale } from '../i18n/resolve-ui-locale.ts';
import { I18N_ES } from './i18n-es.ts';
import { I18N_JA } from './i18n-ja.ts';
import { I18N_KO } from './i18n-ko.ts';
import { I18N_ZH_CN } from './i18n-zh-cn.ts';

/** 可下发字典件的 locale → 真译文。 */
export const UI_I18N_DICTS: Record<UiI18nFileLocale, Record<string, string>> = {
  es: I18N_ES,
  ja: I18N_JA,
  ko: I18N_KO,
  'zh-CN': I18N_ZH_CN,
};

/**
 * 取 locale 对应真字典；en 或未知返回 undefined（调用方走 en 原样路径）。
 */
export function getUiI18nDict(locale: UiLocale): Record<string, string> | undefined {
  if (locale === 'en') return undefined;
  return UI_I18N_DICTS[locale as UiI18nFileLocale];
}
