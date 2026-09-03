import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UI_CSS, UI_JS } = await import('../src/ui/assets.ts');

/**
 * 真文件产物清单（#520-A 提取 PR）：assets.ts 拼接所用的全部真 .js/.css 文件。
 * 钉死两件事：
 *   1. 磁盘上正好这 23 个真文件、非空（防真文件漏层——CI/Docker 上下文缺文件即红）；
 *   2. 按本清单 + IIFE 包装重组 === UI_JS / UI_CSS 导出（顺序与内容都被钉死，
 *      loader 读盘而非藏字符串副本）。
 */

const JS_FILES = [
  'client/store.js',
  'client/dom.js',
  'client/api.js',
  'client/router.js',
  'client/components/app-nav.js',
  'client/components/identity-switcher.js',
  'client/components/empty-state.js',
  'client/components/modal.js',
  'client/components/paginator.js',
  'client/components/sensitive-content.js',
  'client/pages/inbox.js',
  'client/pages/overview.js',
  'client/pages/notifications.js',
  'client/pages/tasks.js',
  'client/pages/identities.js',
  'client/pages/push-devices.js',
  'client/pages/authorized-clients.js',
  'client/pages/plan.js',
  'client/app.js',
];

const CSS_FILES = ['styles/tokens.css', 'styles/base.css', 'styles/layout.css', 'styles/pages.css'];

function readUi(rel: string): string {
  return readFileSync(new URL(`../src/ui/${rel}`, import.meta.url), 'utf8');
}

function realFilesUnder(dir: string, ext: string): string[] {
  const base = new URL(`../src/ui/${dir}`, import.meta.url);
  return readdirSync(base)
    .filter((name) => name.endsWith(ext))
    .sort();
}

describe('UI real-file manifest (#520-A)', () => {
  test('disk holds exactly the 19 real .js files and 4 real .css files, all non-empty', () => {
    expect(realFilesUnder('client', '.js')).toEqual(['api.js', 'app.js', 'dom.js', 'router.js', 'store.js']);
    expect(realFilesUnder('client/components', '.js')).toEqual([
      'app-nav.js',
      'empty-state.js',
      'identity-switcher.js',
      'modal.js',
      'paginator.js',
      'sensitive-content.js',
    ]);
    expect(realFilesUnder('client/pages', '.js')).toEqual([
      'authorized-clients.js',
      'identities.js',
      'inbox.js',
      'notifications.js',
      'overview.js',
      'plan.js',
      'push-devices.js',
      'tasks.js',
    ]);
    expect(realFilesUnder('styles', '.css')).toEqual(['base.css', 'layout.css', 'pages.css', 'tokens.css']);

    for (const rel of [...JS_FILES, ...CSS_FILES]) {
      const url = new URL(`../src/ui/${rel}`, import.meta.url);
      expect(statSync(url).size).toBeGreaterThan(0);
    }
  });

  test('concatenating the real files in assets.ts order reproduces UI_JS byte-for-byte', () => {
    const wrapperOpen = '(function () {\n' + "  'use strict';\n\n";
    const wrapperClose = '})();';
    const expected = wrapperOpen + JS_FILES.map(readUi).join('') + wrapperClose;
    expect(Buffer.from(expected, 'utf8')).toEqual(Buffer.from(UI_JS, 'utf8'));
  });

  test('concatenating the real css files in assets.ts order reproduces UI_CSS byte-for-byte', () => {
    const expected = CSS_FILES.map(readUi).join('');
    expect(Buffer.from(expected, 'utf8')).toEqual(Buffer.from(UI_CSS, 'utf8'));
  });

  // B6 0 期的真文件基线。更新前必须以 compare-ui-gold.ts 确认差异有意，
  // 从而避免把逻辑重新塞回 TS 字符串或无意修改已抽出的 UI 资源。
  test('served bundle bytes are pinned to the B6 real-file baseline', () => {
    const sha256 = (s: string) =>
      new Bun.CryptoHasher('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
    expect(sha256(UI_JS)).toBe('b71b6e88f7860252738c2498fabc8256761787adcfb0a25b014910025bbef9b0');
    expect(sha256(UI_CSS)).toBe('8bd737bef63e5c751c23d80b57ece4ae1ee32c04e4acfb1cc05b3e1e076f7680');
  });
});
