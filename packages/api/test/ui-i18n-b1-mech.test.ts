/**
 * #137 B1-A 机制件测试：壳键槽 / 转义 / locale / i18n 路由。
 * 不含页面 call-site 迁移完备性（见 B1-B）。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UI_HTML, UI_JS, OUTER_CSP, renderUiHtml } = await import('../src/ui/assets.ts');
const { shellHtml } = await import('../src/ui/shell.ts');
const { withConnectShell } = await import('../src/ui/connect-shell.ts');
const {
  I18N_EN,
  fillI18nSlots,
  escapeHtmlText,
  escapeHtmlAttr,
} = await import('../src/ui/client/i18n-en.ts');
const { resolveUiLocale } = await import('../src/ui/i18n/resolve-ui-locale.ts');
const { registerUiAssets, registerUiShell } = await import('../src/routes/ui-assets.ts');
const { Hono } = await import('hono');

/** origin/main @ b230a084 冻结的 en UI_HTML sha256。 */
const MAIN_UI_HTML_SHA256 =
  'ba8f245b89602117ca6ceca7e270be0d43425fd75243280ba17c14ab11542a39';

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

describe('console i18n B1-A 机制件 (#137)', () => {
  test('en 逐字节：shellHtml(en)+withConnectShell ≡ UI_HTML', () => {
    const en = withConnectShell(shellHtml('en'));
    expect(Buffer.from(en, 'utf8')).toEqual(Buffer.from(UI_HTML, 'utf8'));
    expect(en).toEqual(renderUiHtml('en'));
    expect(en).toContain('<html lang="en">');
    expect(en).not.toContain('/ui/i18n/');
    expect(sha256(UI_HTML)).toBe(MAIN_UI_HTML_SHA256);
  });

  test('无真字典时非 en 仍走 en 原样', () => {
    const esEmpty = renderUiHtml('es');
    expect(esEmpty).toEqual(renderUiHtml('en'));
    expect(esEmpty).toContain('<html lang="en">');
    expect(esEmpty).not.toContain('/ui/i18n/');
    const esDict = renderUiHtml('es', { 'login.submit': 'Abrir correo' });
    expect(esDict).toContain('<html lang="es">');
    expect(esDict).toContain('<script src="/ui/i18n/es.js" defer></script>');
    expect(esDict).toContain('Abrir correo');
  });

  test('I18N_JS 已拼入 UI_JS（机制落地；页面尚未调 t）', () => {
    expect(UI_JS).toContain('function t(key)');
    expect(UI_JS).toContain('function tFormat(key, vars)');
    expect(UI_JS).toContain('window.OAE_I18N');
    expect(Object.keys(I18N_EN).length).toBeGreaterThan(50);
  });

  test('resolveUiLocale 四例 + q=0', () => {
    expect(resolveUiLocale({ cookie: 'ja', acceptLanguage: 'en' })).toBe('ja');
    expect(resolveUiLocale({ cookie: undefined, acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8' })).toBe(
      'zh-CN',
    );
    expect(resolveUiLocale({ cookie: 'fr-FR', acceptLanguage: undefined })).toBe('en');
    expect(resolveUiLocale({})).toBe('en');
    expect(resolveUiLocale({ acceptLanguage: 'es;q=0, en' })).toBe('en');
    expect(resolveUiLocale({ acceptLanguage: 'es;q=0' })).toBe('en');
  });

  test('/ui/i18n/:locale.js：es 200 + 未知/en 404', async () => {
    const app = new Hono();
    registerUiAssets(app);
    registerUiShell(app);

    const es = await app.request('http://localhost/ui/i18n/es.js');
    expect(es.status).toBe(200);
    expect(es.headers.get('content-type') || '').toContain('text/javascript');
    expect(es.headers.get('content-security-policy')).toBe(OUTER_CSP);
    expect(await es.text()).toContain('window.OAE_I18N');

    expect((await app.request('http://localhost/ui/i18n/fr.js')).status).toBe(404);
    expect((await app.request('http://localhost/ui/i18n/en.js')).status).toBe(404);
  });

  test('对抗：connect $ 字面插入 + HTML 转义 + 回落 + CJK', () => {
    // $ / $& / $$ / $1 字面（文本位 & → &amp;）
    const dollarDict: Record<string, string> = {
      'shell.html.connectAnAgent': 'Pay $1 now $$ and $& plus $` end',
      'shell.html.giveACodingAgentSecureAccess': 'Cost is $2 only',
    };
    const injected = withConnectShell(shellHtml('es', dollarDict), dollarDict);
    expect(injected).toContain('Pay $1 now $$ and $&amp; plus $` end');
    expect(injected).toContain('Cost is $2 only');
    expect(injected.match(/\$1/g)?.length).toBeGreaterThanOrEqual(1);

    expect(fillI18nSlots('<p>{{login.title}}</p>', { 'login.title': 'Price $1 / $$ / $&' })).toBe(
      '<p>Price $1 / $$ / $&amp;</p>',
    );

    const evil = `<>"'&`;
    expect(escapeHtmlText(evil)).toBe('&lt;&gt;"\'&amp;');
    expect(escapeHtmlAttr(evil)).toBe('&lt;&gt;&quot;&#39;&amp;');
    expect(fillI18nSlots('<span>{{login.title}}</span>', { 'login.title': evil })).toBe(
      '<span>&lt;&gt;"\'&amp;</span>',
    );
    expect(
      fillI18nSlots('<input placeholder="{{shell.html.search}}">', {
        'shell.html.search': evil,
      }),
    ).toBe('<input placeholder="&lt;&gt;&quot;&#39;&amp;">');

    expect(fillI18nSlots('<b>{{login.submit}}</b>', {})).toBe(
      `<b>${I18N_EN['login.submit']}</b>`,
    );
    expect(renderUiHtml('es')).toEqual(renderUiHtml('en'));

    const cjk = renderUiHtml('zh-CN', {
      'login.submit': '登录',
      'shell.html.levelUrgent': '紧急',
    });
    expect(cjk).toContain('<html lang="zh-CN">');
    expect(cjk).toContain('登录');
    expect(cjk).toContain('>紧急<');
    expect(cjk).toContain('value="urgent"');
  });

  test('壳模板 option 可见文本为槽（value 协议值不动）', () => {
    const shellSrc = readFileSync(join(import.meta.dir, '../src/ui/shell.ts'), 'utf8');
    const tm = shellSrc.match(/const SHELL_HTML_TEMPLATE = ("(?:\\.|[^"\\])*")/);
    const tpl: string = JSON.parse(tm![1]!);
    expect(tpl).toContain('value="urgent">{{shell.html.levelUrgent}}<');
    expect(tpl).toContain('value="normal">{{shell.html.levelNormal}}<');
    expect(tpl).toContain('value="low">{{shell.html.levelLow}}<');
    expect(I18N_EN['shell.html.levelUrgent']).toBe('urgent');
  });
});
