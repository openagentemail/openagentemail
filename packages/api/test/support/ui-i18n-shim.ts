/**
 * 测试 shim：为 new Function 抽片的 UI 源码提供全局 t()。
 * 生产 IIFE 内自有 t；抽片跑在隔离 Function 作用域，自由变量回落 globalThis。
 */
import { I18N_EN } from '../../src/ui/client/i18n-en.ts';

(globalThis as typeof globalThis & { t: (key: string) => string }).t = (key: string) =>
  I18N_EN[key] || key;
