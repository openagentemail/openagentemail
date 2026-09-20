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
  fillI18nSlots,
  escapeHtmlText,
  escapeHtmlAttr,
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

  test('①b 无真字典时非 en locale 仍走 en 原样（R4①）', () => {
    const esEmpty = renderUiHtml('es');
    expect(esEmpty).toEqual(renderUiHtml('en'));
    expect(esEmpty).toContain('<html lang="en">');
    expect(esEmpty).not.toContain('/ui/i18n/');
    // 真字典在场才翻 lang + script
    const esDict = renderUiHtml('es', { 'login.submit': 'Abrir correo' });
    expect(esDict).toContain('<html lang="es">');
    expect(esDict).toContain('<script src="/ui/i18n/es.js" defer></script>');
    expect(esDict).toContain('Abrir correo');
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

  test('R3-P1-1：键槽填充；Codex 反例 Open/notice warning 不得污染', () => {
    // en 路径：dict 忽略，逐字节护栏
    const enWithDict = shellHtml('en', { 'shell.html.signOut': 'Cerrar sesión' });
    expect(Buffer.from(enWithDict, 'utf8')).toEqual(Buffer.from(shellHtml('en'), 'utf8'));

    const mockDict: Record<string, string> = {
      'shell.html.signOut': '【退出】',
      'shell.html.menu': '【菜单】',
      'shell.html.work': '【工作】',
      'login.submit': '【打开邮箱】',
      'login.title': '【无噪收件箱。】',
      // Codex 反例形态：若误用子串替换会污染 brand / class
      'shell.html.openCounterexample': 'Open',
      'shell.html.noticeWarningCounterexample': 'notice warning',
    };

    const es = renderUiHtml('es', mockDict);
    expect(es).toContain('<html lang="es">');
    expect(es).toContain('<script src="/ui/i18n/es.js" defer></script>');
    expect(es).toContain('【退出】');
    expect(es).toContain('【打开邮箱】');
    expect(es).not.toContain('>Sign out<');
    expect(es).not.toContain('>Open Mail<');

    // 反例：wordmark / title / class 属性必须原样
    expect(es).toContain('>OpenAgent.email<');
    expect(es).toContain('<title>OpenAgent Home</title>');
    expect(es).toMatch(/class="notice warning"/);
    // 「Open」/「notice warning」即使出现在 mock 字典也不得污染 brand / class（键槽无此槽）
    expect((es.match(/OpenAgent\.email/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(es).not.toContain('【打开邮箱】Agent');

    // 键槽填充保真：模板 + en 值 ≡ shellHtml(en)
    const slotted = fillI18nSlots('X{{login.submit}}Y{{shell.html.signOut}}Z');
    expect(slotted).toBe('XOpen MailYSign outZ');

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

  test('R3-P1-2：完备性——裸 UI 字面量差集；Copy setup 红证已绿', () => {
    /** 显式 allowlist：非 UI 壳层（agent 粘贴指令 / 配置体 / 路径 / CSS / 技术 token）。 */
    const ALLOWLIST: RegExp[] = [
      /^I already (saved|added|merged) /,
      /^In your shell, run read/,
      /^Open ChatGPT Settings/,
      /^Open Grok settings/,
      /^OAuth connector setup is coming/,
      /^~\/\./,
      /^claude mcp add /,
      /^\[mcp_servers/,
      /^http_headers/,
      /^Bearer /,
      /^Authorization/,
      /^openagent-email$/,
      /^openagent_email$/,
      /^Terminal command$/,
      // CSS / DOM 技术串
      /^(quiet|primary|notice|tab|cell|home-|overview-|connect-|task-|row-|is-|sr-only)/,
      /home-link|home-count|seen-toggle|tab-headers|delete-action|row-flat|is-selected/,
      /^noopener noreferrer$/,
      // 日期输入拼装碎片（非可见文案）
      /^T\d{2}:\d{2}:\d{2}/,
      // 纯技术 / 短状态 token
      /^(urgent|normal|low|active|failed|completed|all|inbox|sent|admin)$/i,
      /^[a-z0-9_-]+$/, // 无空格标识符
      /^https?:\/\//,
      /^\/ui\//,
      /^\?/,
      /^&/,
      /^#/,
      /^\$/,
      /^<\w/,
      // 数字/单位碎片
      /^\d+$/,
      /^[·•]+$/,
      /^••••/,
    ];

    const enValues = new Set(Object.values(I18N_EN));
    const root = join(import.meta.dir, '../src/ui/client');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(root);

    /** 抽取单引号字面量（足够覆盖本仓 UI 字面量风格）。 */
    function literals(src: string): string[] {
      const out: string[] = [];
      const re = /'((?:\\'|[^'])*)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) out.push(m[1]!.replace(/\\'/g, "'"));
      return out;
    }

    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes('i18n-en')) continue;
      const src = readFileSync(f, 'utf8');
      for (const lit of literals(src)) {
        if (lit.length < 4) continue;
        if (!/[A-Za-z]/.test(lit)) continue;
        if (ALLOWLIST.some((re) => re.test(lit))) continue;
        // 与字典值全等 → 未迁移的可见英文
        if (enValues.has(lit)) {
          offenders.push(`${f.replace(/.*\/client\//, '')}: ${JSON.stringify(lit)}`);
        }
      }
    }

    // 红证：迁移前 connect 页存在裸 'Copy setup'；迁移后不得再出现该精确字面量
    const connectSrc = readFileSync(join(root, 'pages/connect.js'), 'utf8');
    const connectLits = literals(connectSrc);
    expect(connectLits.filter((s) => s === 'Copy setup')).toEqual([]);
    expect(connectSrc).toContain("t('connect.copy.copySetup')");

    expect(offenders).toEqual([]);

    // ② 负向：cookie / rel 赋值右侧不得出现 t(
    const appSrc = readFileSync(join(root, 'app.js'), 'utf8');
    expect(appSrc).not.toMatch(/document\.cookie\s*=\s*t\(/);
    expect(appSrc).not.toMatch(/\.rel\s*=\s*t\(/);
    // 字典值不得匹配协议/鉴权技术串
    for (const [k, v] of Object.entries(I18N_EN)) {
      if (/^(Bearer |Authorization|; Secure)/.test(v) || /SameSite=/.test(v) || v === 'noopener noreferrer') {
        throw new Error(`tech value still in I18N_EN: ${k}=${JSON.stringify(v)}`);
      }
    }
  });

  test('R4-④：槽值 HTML 完整转义 + 属性 breakout 负向', () => {
    expect(escapeHtmlText(`a<b>c&d`)).toBe('a&lt;b&gt;c&amp;d');
    expect(escapeHtmlAttr(`x"y'z`)).toBe('x&quot;y&#39;z');

    const evilText = 'Hi <img src=x onerror=alert(1)> & "q"';
    const textOut = fillI18nSlots('<p>{{login.title}}</p>', {
      'login.title': evilText,
    });
    expect(textOut).not.toContain('<img');
    expect(textOut).toContain('&lt;img');
    expect(textOut).toContain('&amp;');
    expect(textOut).not.toMatch(/<p>Hi <img/);

    // 属性 breakout：译文含 " 不得截断/逃出 placeholder
    const evilAttr = 'foo" onclick="alert(1)';
    const attrOut = fillI18nSlots(
      '<input placeholder="{{shell.html.search}}">',
      { 'shell.html.search': evilAttr },
    );
    expect(attrOut).toContain('placeholder="foo&quot; onclick=&quot;alert(1)"');
    expect(attrOut).not.toMatch(/placeholder="foo"/);
    expect(attrOut).not.toContain('onclick="alert');
    // 单引号属性同理
    const attrOut2 = fillI18nSlots(
      "<input aria-label='{{shell.a11y.dashboard}}'>",
      { 'shell.a11y.dashboard': `x' onclick='alert(1)` },
    );
    expect(attrOut2).toContain("aria-label='x&#39; onclick=&#39;alert(1)'");
    expect(attrOut2).not.toContain("onclick='alert");
  });

  test('R4-③：壳模板无未槽化用户可见英文（allowlist 除外）', () => {
    // 从 shell.ts 源解析模板字符串
    const shellSrc = readFileSync(
      join(import.meta.dir, '../src/ui/shell.ts'),
      'utf8',
    );
    const m = shellSrc.match(
      /const SHELL_HTML_TEMPLATE = ("(?:\\.|[^"\\])*")/,
    );
    expect(m).toBeTruthy();
    const tpl: string = JSON.parse(m![1]!);
    // 文本节点 / aria-label / placeholder 中的裸英文
    const texts = [
      ...[...tpl.matchAll(/>([^<{][^<]{0,200})</g)].map((x) => x[1]!),
      ...[...tpl.matchAll(/(?:aria-label|placeholder)="([^"{]*)"/g)].map(
        (x) => x[1]!,
      ),
    ]
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && /[A-Za-z]/.test(s));

    /** 模板内允许保留的非槽英文（品牌 / 技术 option 值） */
    const TPL_ALLOW = new Set([
      'OpenAgent Home',
      'OpenAgent.email',
      'urgent',
      'normal',
      'low',
      '20',
      '50',
      '100',
    ]);
    const leftover = [...new Set(texts)].filter(
      (s) => !TPL_ALLOW.has(s) && !/^\d+$/.test(s),
    );
    expect(leftover).toEqual([]);
  });

  test('R4-⑤：错误路径整句模板 en 逐字', () => {
    expect(I18N_EN['api.announce.pushContentTierRefreshed']).toBe(
      'Push content tier is tier {tier} for {address} (refreshed).',
    );
    expect(I18N_EN['overview.announce.addressNoLongerAvailable']).toBe(
      '{address} is no longer available. Back to Home.',
    );
    const fmt = (k: string, vars: Record<string, string | number>) =>
      (I18N_EN[k] || k).replace(/\{(\w+)\}/g, (_m, n: string) =>
        vars[n] != null ? String(vars[n]) : '',
      );
    expect(
      fmt('api.announce.pushContentTierRefreshed', {
        tier: 2,
        address: 'a@test.example',
      }),
    ).toBe('Push content tier is tier 2 for a@test.example (refreshed).');
    expect(
      fmt('overview.announce.addressNoLongerAvailable', {
        address: 'gone@test.example',
      }),
    ).toBe('gone@test.example is no longer available. Back to Home.');
  });
});
