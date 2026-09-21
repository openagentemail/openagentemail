/**
 * #137 B2 控制台 i18n 落串测试：
 * ① 键集全等 ×4 ② 保真扫描（PRESERVED 逐字节）③ 非 en 渲染（lang+script）
 * ④ 字典件真译文 ⑤ 语言选择器 cookie 写入面 ⑥ oauth locale 归一
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UI_HTML, UI_JS, renderUiHtml } = await import('../src/ui/assets.ts');
const { shellHtml } = await import('../src/ui/shell.ts');
const { withConnectShell } = await import('../src/ui/connect-shell.ts');
const { I18N_EN, i18nLocaleScript } = await import('../src/ui/client/i18n-en.ts');
const { I18N_ES } = await import('../src/ui/client/i18n-es.ts');
const { I18N_JA } = await import('../src/ui/client/i18n-ja.ts');
const { I18N_KO } = await import('../src/ui/client/i18n-ko.ts');
const { I18N_ZH_CN } = await import('../src/ui/client/i18n-zh-cn.ts');
const { I18N_PRESERVED_KEYS } = await import('../src/ui/client/i18n-preserved.ts');
const { getUiI18nDict } = await import('../src/ui/client/i18n-dicts.ts');
const { oauthCopy } = await import('../src/ui/i18n/oauth-copy.ts');
const { registerUiAssets, registerUiShell } = await import('../src/routes/ui-assets.ts');
const { Hono } = await import('hono');

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

const LOCALES = [
  { code: 'es' as const, dict: I18N_ES },
  { code: 'ja' as const, dict: I18N_JA },
  { code: 'ko' as const, dict: I18N_KO },
  { code: 'zh-CN' as const, dict: I18N_ZH_CN },
];

describe('console i18n B2 (#137)', () => {
  test('① 键集全等 ×4：每 locale ≡ I18N_EN', () => {
    const enKeys = Object.keys(I18N_EN).sort();
    expect(enKeys.length).toBe(513);
    for (const { code, dict } of LOCALES) {
      const keys = Object.keys(dict).sort();
      expect(keys, `${code} key parity`).toEqual(enKeys);
    }
  });

  test('② 保真扫描：PRESERVED 键四字典值 === en 逐字节', () => {
    expect(I18N_PRESERVED_KEYS.length).toBeGreaterThan(20);
    const fails: string[] = [];
    for (const key of I18N_PRESERVED_KEYS) {
      const enVal = I18N_EN[key];
      expect(enVal, `en missing ${key}`).toBeDefined();
      for (const { code, dict } of LOCALES) {
        if (dict[key] !== enVal) {
          fails.push(`${code}:${key}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  test('③ 非 en 渲染：lang + i18n script + 壳译文', () => {
    for (const { code, dict } of LOCALES) {
      const html = renderUiHtml(code, dict);
      expect(html).toContain(`<html lang="${code}">`);
      expect(html).toContain(`<script src="/ui/i18n/${code}.js" defer></script>`);
      expect(html).toContain('oa-lang-select');
      // 抽检：语言标签已译（非 en 原文 Language）
      expect(html).toContain(dict['shell.html.language']!);
      expect(html).not.toContain('{{');
    }
  });

  test('③b en 仍无 i18n script；选择器在场', () => {
    expect(UI_HTML).toContain('<html lang="en">');
    expect(UI_HTML).not.toContain('/ui/i18n/');
    expect(UI_HTML).toContain('oa-lang-select');
    expect(UI_HTML).toContain('>Language<');
    expect(sha256(UI_HTML)).toBe(sha256(withConnectShell(shellHtml('en'))));
  });

  test('④ /ui/i18n/:locale.js 含真译文（非空对象）', async () => {
    const app = new Hono();
    registerUiAssets(app);
    registerUiShell(app);

    for (const { code, dict } of LOCALES) {
      const res = await app.request(`http://localhost/ui/i18n/${code}.js`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.startsWith('window.OAE_I18N = ')).toBe(true);
      expect(body).not.toBe('window.OAE_I18N = {};\n');
      // 抽检登录标题译文在字典件内
      expect(body).toContain(JSON.stringify(dict['login.title']));
      // i18nLocaleScript 与路由一致
      expect(i18nLocaleScript(code)).toBe(body);
    }
  });

  test('④b shell 集成：cookie oa_lang=es → 真 es 壳', async () => {
    const app = new Hono();
    registerUiAssets(app);
    registerUiShell(app);
    const res = await app.request('http://localhost/ui', {
      headers: { Cookie: 'oa_lang=es' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('/ui/i18n/es.js');
    expect(html).toContain(I18N_ES['login.title']!);
  });

  test('⑤ 语言选择器：UI_JS 写 oa_lang cookie 属性', () => {
    expect(UI_JS).toContain("oa_lang=");
    expect(UI_JS).toContain('Path=/ui');
    expect(UI_JS).toContain('Max-Age=31536000');
    expect(UI_JS).toContain('SameSite=Lax');
    expect(UI_JS).toContain('oa-lang-select');
    expect(UI_JS).toContain('window.location.reload()');
  });

  test('⑥ oauth copy 五 locale 齐备；zh-CN handoff 仍中文', () => {
    for (const loc of ['en', 'es', 'ja', 'ko', 'zh-CN'] as const) {
      const c = oauthCopy(loc);
      expect(c.brandSuffix).toBe('OpenAgent.email');
      expect(c.localpartPlaceholder).toBe('localpart');
      expect(c.handoffH1.length).toBeGreaterThan(0);
    }
    expect(oauthCopy('zh-CN').handoffH1).toContain('已授权');
    expect(oauthCopy('en').handoffH1).toContain('Authorized');
    expect(oauthCopy('es').authorizeH1).not.toBe(oauthCopy('en').authorizeH1);
  });

  test('getUiI18nDict：en undefined；四语非空', () => {
    expect(getUiI18nDict('en')).toBeUndefined();
    expect(Object.keys(getUiI18nDict('ja')!).length).toBe(513);
  });

  test('P1 自审修复：Alerts 日期筛标签 ≠ 邮件 From/To', () => {
    // shell.html.from/to 保留邮件头语义；dateFrom/dateTo 专供 notify 日期筛
    expect(I18N_EN['shell.html.from']).toBe('From');
    expect(I18N_EN['shell.html.dateFrom']).toBe('From');
    expect(I18N_ZH_CN['shell.html.from']).toBe('发件人');
    expect(I18N_ZH_CN['shell.html.dateFrom']).toBe('开始日期');
    expect(I18N_ES['shell.html.dateFrom']).toBe('Desde');
    expect(I18N_JA['shell.html.dateTo']).toBe('終了日');
    expect(I18N_KO['shell.html.dateTo']).toBe('종료일');
    const zh = renderUiHtml('zh-CN', I18N_ZH_CN);
    expect(zh).toMatch(/for="notify-from">开始日期</);
    expect(zh).toMatch(/for="notify-to">结束日期</);
    expect(zh).not.toMatch(/for="notify-from">发件人</);
  });

  test('R1 P1-2：oauth.error.* 五字典齐；预检错误键非英文保真项', () => {
    for (const key of [
      'oauth.error.missingClientOrRedirect',
      'oauth.error.invalidClient',
      'oauth.error.redirectUriUnregistered',
    ] as const) {
      expect(I18N_EN[key]).toBeDefined();
      expect(I18N_ES[key]).not.toBe(I18N_EN[key]);
      expect(I18N_JA[key]).not.toBe(I18N_EN[key]);
      expect(I18N_KO[key]).not.toBe(I18N_EN[key]);
      expect(I18N_ZH_CN[key]).not.toBe(I18N_EN[key]);
    }
  });
});
