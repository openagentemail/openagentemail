/**
 * 配置解析与测试还原共用的 URL 规范化。
 * 只去掉 pathname 上多余的尾斜杠，查询串和 fragment 原样保留。
 *
 * Canonical form keeps configured and request URLs comparable as origins.
 * Only drops a redundant trailing slash on the pathname — never rewrites
 * query values or fragments (e.g. `?next=/` and `#/` must survive).
 * Exported so notify device pairing uses the same normalizer as config.
 */
export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  // Root path serializes as "https://host/" (or with userinfo). Prefer href so
  // publisher:secret@host credentials survive; origin alone drops userinfo.
  // Only apply when search/hash are empty so those branches keep full href.
  if (url.pathname === '/' && url.search === '' && url.hash === '') {
    return url.href.replace(/\/+$/, '');
  }
  return url.href;
}
