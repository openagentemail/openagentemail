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
 *   1. 磁盘上正好这 24 个真文件、非空（防真文件漏层——CI/Docker 上下文缺文件即红）；
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
  'client/pages/connect.js',
  'client/pages/plan.js',
  'client/app.js',
];

const CSS_FILES = [
  'styles/tokens.css',
  'styles/base.css',
  'styles/layout.css',
  'styles/pages.css',
];

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
  test('disk holds exactly the 20 real .js files and 4 real .css files, all non-empty', () => {
    expect(realFilesUnder('client', '.js')).toEqual([
      'api.js',
      'app.js',
      'dom.js',
      'router.js',
      'store.js',
    ]);
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
      'connect.js',
      'identities.js',
      'inbox.js',
      'notifications.js',
      'overview.js',
      'plan.js',
      'push-devices.js',
      'tasks.js',
    ]);
    expect(realFilesUnder('styles', '.css')).toEqual([
      'base.css',
      'layout.css',
      'pages.css',
      'tokens.css',
    ]);

    for (const rel of [...JS_FILES, ...CSS_FILES]) {
      const url = new URL(`../src/ui/${rel}`, import.meta.url);
      expect(statSync(url).size).toBeGreaterThan(0);
    }
  });

  test('concatenating the real files in assets.ts order reproduces UI_JS byte-for-byte', async () => {
    const { I18N_JS } = await import('../src/ui/client/i18n-en.ts');
    const wrapperOpen = '(function () {\n' + "  'use strict';\n\n";
    const wrapperClose = '})();';
    // #137 B1：I18N_JS（TS 生成）插在真 .js 清单之前。
    const expected = wrapperOpen + I18N_JS + JS_FILES.map(readUi).join('') + wrapperClose;
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
      new Bun.CryptoHasher('sha256')
        .update(Buffer.from(s, 'utf8'))
        .digest('hex');
    // #134、#196/R3 与 #231 Connect 页面均为有意 UI 变更；更新前已确认差异有意。
    // #231 R6：Claude 卡 $OAE_TOKEN 零凭证命令后更新 UI_JS 针脚。
    // #162+#163：tasks 轮询旧∪新 sync + overview 硬停文案诚实化（纯 UI）。
    // #137 B1：拼入 I18N_JS + call-site t()；en 文案零变化，UI_JS 字节因字典/t() 增长。
    // #137 R2：自检直查 I18N_EN + tFormat 整句模板 + 同形面回扫。
    expect(sha256(UI_JS)).toBe(
      '94098ec612bb5a49d60acad02ba00c0bc5d675dad9ce16d4bf514e851f2fffa1',
    );
    expect(sha256(UI_CSS)).toBe(
      'bccfd50b1660b04dde56701ad2c5d1aae7d0900de4990c0d75a03318f2d06043',
    );
  });
});
