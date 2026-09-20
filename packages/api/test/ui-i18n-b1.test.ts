/**
 * #137 B1 控制台 i18n 基建测试：
 * ① en 逐字节快照 ② t() 键完备 ③ resolveUiLocale 四例
 * ④ /ui/i18n/:locale.js ⑤ 由全量套件覆盖
 * R2：P1-1 自检不经 t；P1-2 非 en 字面量替换；P1-3 摘要模板；P1-4 q=0 过滤
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
const {
  I18N_EN,
  I18N_JS,
  applyI18nLiteralReplacements,
  tServer,
} = await import('../src/ui/client/i18n-en.ts');
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

  test('② 键完备：每个 t(\'…\') / tFormat(\'…\') 调用键 ∈ I18N_EN', () => {
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

    const re = /\bt(?:Format)?\(\s*['"]([^'"]+)['"]/g;
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
    expect(UI_JS).toContain('function tFormat(key, vars)');
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

describe('console i18n R2 P1×4 (#137)', () => {
  test('P1-1：自检直查 I18N_EN；假 OAE_I18N 自检键不抛且 t() 返译文', () => {
    // 自检片段不得调用 t(（须直查 I18N_EN[…]）
    expect(I18N_JS).toContain('if (I18N_EN[');
    const selfCheckBlock = I18N_JS.slice(I18N_JS.indexOf('i18n_en_empty'));
    expect(selfCheckBlock).not.toContain('t(');

    const selfKey = Object.keys(I18N_EN).sort()[0]!;
    const selfVal = I18N_EN[selfKey]!;
    const fakeVal = 'FAKE_OAE_I18N_SELF_CHECK_TRANSLATION';

    // 在隔离作用域执行 I18N_JS：先注入假 OAE_I18N，再跑自检+t
    const run = new Function(
      'window',
      I18N_JS +
        ';\n' +
        'return { t: t, lookedUp: t(' +
        JSON.stringify(selfKey) +
        '), enVal: I18N_EN[' +
        JSON.stringify(selfKey) +
        '] };\n',
    );
    const windowStub: { OAE_I18N: Record<string, string> } = {
      OAE_I18N: { [selfKey]: fakeVal },
    };
    const out = run(windowStub) as {
      t: (k: string) => string;
      lookedUp: string;
      enVal: string;
    };
    expect(out.enVal).toBe(selfVal);
    expect(out.lookedUp).toBe(fakeVal);
    expect(() => out.t(selfKey)).not.toThrow();
  });

  test('P1-2：非 en 字面量最长优先替换；en 逐字节不变；tServer(dict?)', () => {
    // en 路径：dict 被忽略，逐字节护栏
    const enWithDict = shellHtml('en', { 'shell.html.signOut': 'Cerrar sesión' });
    expect(Buffer.from(enWithDict, 'utf8')).toEqual(Buffer.from(shellHtml('en'), 'utf8'));

    // mock locale 字典：含 5 键译文（单测内构造；不动 /ui/i18n/:locale.js）
    const mockDict: Record<string, string> = {
      'shell.html.signOut': '【退出】',
      'shell.html.menu': '【菜单】',
      'shell.html.work': '【工作】',
      'login.submit': '【打开邮箱】',
      'login.title': '【无噪收件箱。】',
    };
    expect(shellHtml('en')).toContain(I18N_EN['shell.html.signOut']!);
    expect(shellHtml('en')).toContain(I18N_EN['login.submit']!);

    const es = shellHtml('es', mockDict);
    expect(es).toContain('<html lang="es">');
    expect(es).toContain('<script src="/ui/i18n/es.js" defer></script>');
    expect(es).toContain('【退出】');
    expect(es).toContain('【菜单】');
    expect(es).toContain('【工作】');
    expect(es).toContain('【打开邮箱】');
    expect(es).toContain('【无噪收件箱。】');
    expect(es).not.toContain('>Sign out<');
    expect(es).not.toContain('>Open Mail<');

    // 期望 HTML = lang+script 注入后再做替换
    let expected = shellHtml('en')
      .replace('<html lang="en">', '<html lang="es">')
      .replace(
        '<script src="/ui/app.js" defer></script>',
        '<script src="/ui/i18n/es.js" defer></script>\n  <script src="/ui/app.js" defer></script>',
      );
    expected = applyI18nLiteralReplacements(expected, mockDict);
    expect(es).toBe(expected);

    // 最长优先：短串是长串子串时不得半替换
    const longFirstDict: Record<string, string> = {
      'shell.html.signOut': '【退出登录】',
    };
    const sample = 'Please Sign out now';
    expect(applyI18nLiteralReplacements(sample, longFirstDict)).toBe('Please 【退出登录】 now');

    // tServer(dict?)
    expect(tServer('login.submit')).toBe('Open Mail');
    expect(tServer('login.submit', mockDict)).toBe('【打开邮箱】');
    expect(tServer('missing.key', mockDict)).toBe('missing.key');
  });

  test('P1-3：notifications 摘要 en 逐字=原句；假字典整句无裸英文碎片', () => {
    const todayEn = I18N_EN['notifications.summary.today']!;
    const lastEn = I18N_EN['notifications.summary.lastClause']!;
    // en 模板值必须是「拼好的原句」形态
    expect(todayEn).toBe(
      "Today ({tz}): {total} sent · {urgent} urgent{lastClause}. Undelivered notifications are not included in today’s sent count.",
    );
    expect(lastEn).toBe(' · last {last}');

    // 模拟 en 渲染（与现状拼接结果逐字一致）
    function formatSummary(
      dict: Record<string, string>,
      opts: { tz: string; total: number; urgent: number; last?: string },
    ): string {
      const t = (k: string) => dict[k] || I18N_EN[k] || k;
      const tFormat = (k: string, vars: Record<string, string | number>) =>
        t(k).replace(/\{(\w+)\}/g, (_m, n: string) =>
          vars[n] != null ? String(vars[n]) : '',
        );
      const lastClause = opts.last
        ? tFormat('notifications.summary.lastClause', { last: opts.last })
        : '';
      return tFormat('notifications.summary.today', {
        tz: opts.tz,
        total: opts.total,
        urgent: opts.urgent,
        lastClause,
      });
    }

    const enOut = formatSummary(I18N_EN, {
      tz: 'UTC',
      total: 3,
      urgent: 1,
      last: '14:02',
    });
    expect(enOut).toBe(
      "Today (UTC): 3 sent · 1 urgent · last 14:02. Undelivered notifications are not included in today’s sent count.",
    );

    const fakeDict: Record<string, string> = {
      ...I18N_EN,
      'notifications.summary.today':
        '本日（{tz}）：送信 {total} · 緊急 {urgent}{lastClause}。未達通知は本日の送信数に含まれません。',
      'notifications.summary.lastClause': ' · 最終 {last}',
    };
    const jaOut = formatSummary(fakeDict, {
      tz: 'Asia/Tokyo',
      total: 2,
      urgent: 0,
      last: '09:00',
    });
    expect(jaOut).toContain('本日（Asia/Tokyo）');
    expect(jaOut).not.toContain(' sent · ');
    expect(jaOut).not.toContain(' urgent');
    expect(jaOut).not.toMatch(/\bToday\b/);
  });

  test('P1-4：Accept-Language q=0 过滤', () => {
    expect(resolveUiLocale({ acceptLanguage: 'es;q=0, en' })).toBe('en');
    expect(resolveUiLocale({ acceptLanguage: 'es;q=0' })).toBe('en');
  });
});
