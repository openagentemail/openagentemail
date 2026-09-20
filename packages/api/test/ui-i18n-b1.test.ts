/**
 * #137 B1 控制台 i18n 基建测试：
 * ① en 逐字节快照 ② t() 键完备 ③ resolveUiLocale 四例
 * ④ /ui/i18n/:locale.js ⑤ 由全量套件覆盖
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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
const { I18N_EN } = await import('../src/ui/client/i18n-en.ts');
const { resolveUiLocale } = await import('../src/ui/i18n/resolve-ui-locale.ts');
const { registerUiAssets, registerUiShell } = await import('../src/routes/ui-assets.ts');
const { Hono } = await import('hono');

/** 从 origin/main @ b230a084 冻结的 en UI_HTML sha256（亲验逐字节一致）。 */
const MAIN_UI_HTML_SHA256 =
  'ba8f245b89602117ca6ceca7e270be0d43425fd75243280ba17c14ab11542a39';

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

describe('console i18n B1 (#137)', () => {
  test('① en 逐字节：shellHtml(en)+withConnectShell ≡ UI_HTML', () => {
    const en = withConnectShell(shellHtml('en'));
    expect(Buffer.from(en, 'utf8')).toEqual(Buffer.from(UI_HTML, 'utf8'));
    expect(en).toEqual(renderUiHtml('en'));
    // 不加 i18n script；lang 仍为 en
    expect(en).toContain('<html lang="en">');
    expect(en).not.toContain('/ui/i18n/');
  });

  test('①b 非 en 注入字典件 script + lang', () => {
    const es = renderUiHtml('es');
    expect(es).toContain('<html lang="es">');
    expect(es).toContain('<script src="/ui/i18n/es.js" defer></script>');
    expect(es).toContain('<script src="/ui/app.js" defer></script>');
    // en 基线仍不变
    expect(UI_HTML).not.toContain('/ui/i18n/');
  });

  test('② 键完备：每个 t(\'…\') 调用键 ∈ I18N_EN', () => {
    const root = join(import.meta.dir, '../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|ts)$/.test(e.name) && !e.name.includes('i18n-en')) files.push(p);
      }
    };
    walk(join(root, 'ui/client'));
    files.push(join(root, 'routes/ui-frame.ts'));

    const re = /\bt\(\s*['"]([^'"]+)['"]\s*\)/g;
    const missing: string[] = [];
    let used = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        used += 1;
        if (!(m[1] in I18N_EN)) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(used).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  test('③ resolveUiLocale 四例', () => {
    // cookie 命中
    expect(resolveUiLocale({ cookie: 'ja', acceptLanguage: 'en' })).toBe('ja');
    // Accept-Language zh 前缀 → zh-CN
    expect(resolveUiLocale({ cookie: undefined, acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8' })).toBe(
      'zh-CN',
    );
    // 非法 cookie → 回落 Accept-Language / en
    expect(resolveUiLocale({ cookie: 'fr-FR', acceptLanguage: undefined })).toBe('en');
    // 双缺省 → en
    expect(resolveUiLocale({})).toBe('en');
  });

  test('④ /ui/i18n/:locale.js：es 200 + 未知 404', async () => {
    const app = new Hono();
    registerUiAssets(app);
    registerUiShell(app);

    const es = await app.request('http://localhost/ui/i18n/es.js');
    expect(es.status).toBe(200);
    expect(es.headers.get('content-type') || '').toContain('text/javascript');
    expect(es.headers.get('content-security-policy')).toBe(OUTER_CSP);
    expect(es.headers.get('x-content-type-options')).toBe('nosniff');
    expect(es.headers.get('cache-control')).toBe('no-cache');
    const body = await es.text();
    expect(body).toContain('window.OAE_I18N');

    const unknown = await app.request('http://localhost/ui/i18n/fr.js');
    expect(unknown.status).toBe(404);

    // en 不设件
    const en = await app.request('http://localhost/ui/i18n/en.js');
    expect(en.status).toBe(404);
  });

  test('I18N_JS 已拼入 UI_JS 且含 t()', () => {
    expect(UI_JS).toContain('function t(key)');
    expect(UI_JS).toContain('window.OAE_I18N');
    expect(UI_JS).toContain('I18N_EN');
    // 自检锚
    expect(UI_JS).toContain('i18n_en_empty');
  });

  test('en UI_HTML sha 钉死 origin/main 基线', () => {
    expect(sha256(UI_HTML)).toBe(MAIN_UI_HTML_SHA256);
    expect(sha256(withConnectShell(shellHtml('en')))).toBe(MAIN_UI_HTML_SHA256);
  });
});
