/**
 * 控制台 UI locale 单点解析（#137 B1）。
 * 优先级：cookie oa_lang → Accept-Language（精确后前缀回退）→ 默认 en。
 * 非法值一律回 en（fail-closed）。路由层唯一入口。
 */

/** 产品统一 locale 词汇表（cookie / Accept-Language / 字典件共用）。 */
export const UI_LOCALES = ['en', 'es', 'ja', 'ko', 'zh-CN'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** 可下发静态字典件的非 en locale（en 回落内嵌 I18N_EN，不设件）。 */
export const UI_I18N_FILE_LOCALES = ['es', 'ja', 'ko', 'zh-CN'] as const;
export type UiI18nFileLocale = (typeof UI_I18N_FILE_LOCALES)[number];

const LOCALE_SET = new Set<string>(UI_LOCALES);
const FILE_LOCALE_SET = new Set<string>(UI_I18N_FILE_LOCALES);

/** 是否为合法 UI locale。 */
export function isUiLocale(value: string): value is UiLocale {
  return LOCALE_SET.has(value);
}

/** 是否为可下发字典件的 locale（未知 fail-closed → 404）。 */
export function isUiI18nFileLocale(value: string): value is UiI18nFileLocale {
  return FILE_LOCALE_SET.has(value);
}

/**
 * 将任意原始串规范化为 UiLocale；无法识别则 null（由调用方回 en）。
 * zh* 前缀统一映射 zh-CN。
 */
export function normalizeUiLocale(raw: string | undefined | null): UiLocale | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 精确命中
  if (isUiLocale(trimmed)) return trimmed;
  // BCP47 大小写变体（如 zh-cn → zh-CN）
  const lower = trimmed.toLowerCase();
  if (lower === 'zh-cn') return 'zh-CN';
  for (const loc of UI_LOCALES) {
    if (loc.toLowerCase() === lower) return loc;
  }
  // 前缀回退：zh* → zh-CN；其余取主语言标签精确匹配
  const primary = lower.split(/[-_]/)[0] || '';
  if (primary === 'zh') return 'zh-CN';
  if (primary === 'en' || primary === 'es' || primary === 'ja' || primary === 'ko') {
    return primary;
  }
  return null;
}

/** Accept-Language 条目：过滤 q=0（RFC 9110 显式不可接受）后按 q 降序。 */
function parseAcceptLanguage(header: string | undefined | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = p.trim().match(/^q\s*=\s*([0-9.]+)$/i);
        if (m) q = Number(m[1]);
      }
      return { tag: (tag || '').trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((e) => e.tag && e.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((e) => e.tag);
}

export type ResolveUiLocaleInput = {
  /** oa_lang cookie 原始值 */
  cookie?: string | undefined | null;
  /** Accept-Language 请求头 */
  acceptLanguage?: string | undefined | null;
};

/**
 * 路由层唯一 locale 入口。
 * cookie → Accept-Language → en；非法一律 en。
 */
export function resolveUiLocale(input: ResolveUiLocaleInput): UiLocale {
  const fromCookie = normalizeUiLocale(input.cookie ?? null);
  if (fromCookie) return fromCookie;

  for (const tag of parseAcceptLanguage(input.acceptLanguage ?? null)) {
    const hit = normalizeUiLocale(tag);
    if (hit) return hit;
  }

  return 'en';
}
