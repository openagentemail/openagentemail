/**
 * 测试 shim：为 new Function 抽片的 UI 源码提供全局 t() / tFormat()。
 * 生产 IIFE 内自有 t/tFormat；抽片跑在隔离 Function 作用域，自由变量回落 globalThis。
 */
import { I18N_EN } from '../../src/ui/client/i18n-en.ts';

function t(key: string): string {
  return I18N_EN[key] || key;
}

/** 带参模板：{name} 占位替换；缺省键清空。 */
function tFormat(key: string, vars?: Record<string, string | number>): string {
  let s = t(key);
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_m, name: string) =>
    vars[name] != null ? String(vars[name]) : '',
  );
}

const g = globalThis as typeof globalThis & {
  t: typeof t;
  tFormat: typeof tFormat;
};
g.t = t;
g.tFormat = tFormat;
