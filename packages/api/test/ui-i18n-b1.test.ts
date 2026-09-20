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

  test('R3-P1-2 / B1-B：完备性——非循环裸字面量扫描；Blocked/Health 红证已绿', () => {
    /**
     * 非循环完备性：源码出现非白名单裸字面量（含字母且长度≥4）即红——
     * **不**预设「必须已在字典」成员资格（旧实现的循环 bug）。
     */
    const ALLOWLIST: RegExp[] = [
      // Agent 粘贴指令 / 配置体（语种随 agent，非产品 chrome）
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
      // CSS / DOM / 协议技术串
      /^(quiet|primary|notice|tab|cell|home-|overview-|connect-|task-|row-|is-|sr-only)/,
      /home-link|home-count|seen-toggle|tab-headers|delete-action|row-flat|is-selected/,
      /^noopener noreferrer$/,
      /^T\d{2}:\d{2}:\d{2}/,
      /^(urgent|normal|low|active|failed|completed|all|inbox|sent|admin)$/i,
      /^[a-z0-9_.@:-]+$/, // 无空格标识符 / 路径片段 / email-ish
      /^https?:\/\//,
      /^\/ui\//,
      /^\?/,
      /^&/,
      /^#/,
      /^\$/,
      /^<\w/,
      /^\d+$/,
      /^[·•]+$/,
      /^••••/,
      // 专有名词 / 产品卡名
      /^(Codex|Cursor|ZCode|ChatGPT|Grok|Claude|Kimi|MCP|API|Id|HTML|JSON|QR|SMTP|IMAP)$/,
      /^Message-ID$/,
      /^(internal|external)$/,
      // 相对时间 / 格式碎片
      /^(min ago|h ago|d ago|of | · | — | → )/,
      /^\s*json\\s/,
      /^(AbortError|Escape)$/,
      /^; Secure$/,
      /^oae-link-login=/,
      /^<!-- /, // store.js task result marker（非用户可见）
      /^meta metadata-summary$/,
    ];

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

    function literals(src: string): string[] {
      const out: string[] = [];
      const re = /'((?:\\'|[^'])*)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) out.push(m[1]!.replace(/\\'/g, "'"));
      return out;
    }

    /** 用户可见文案启发式：多词句 / Title Case 词；丢弃含换行伪影与代码碎片。 */
    function looksLikeUiCopy(lit: string): boolean {
      if (lit.includes('\n') || lit.includes('\r')) return false;
      if (/[{}=;<>]|:\s|"/.test(lit)) return false; // 代码/属性碎片
      if (/^[.,;:\s\-_/\\]/.test(lit)) return false;
      if (/\b(function|return|await|const|var |let |state\.|document\.|window\.|String\(|Number\()\b/.test(lit)) {
        return false;
      }
      if (/\s/.test(lit)) return true;
      if (/^[A-Z][a-z][A-Za-z-]*$/.test(lit)) return true; // Blocked / Health / Date
      return false;
    }

    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes('i18n-en')) continue;
      const src = readFileSync(f, 'utf8');
      for (const lit of literals(src)) {
        if (lit.length < 4) continue;
        if (!/[A-Za-z]/.test(lit)) continue;
        if (!looksLikeUiCopy(lit)) continue;
        if (ALLOWLIST.some((re) => re.test(lit))) continue;
        // 非循环：不查字典成员资格
        offenders.push(`${f.replace(/.*\/client\//, '')}: ${JSON.stringify(lit)}`);
      }
    }

    // 红证：Blocked / Health / Unavailable / Date（修前会红）；To 长度<4 另断言
    const RED_PROOF = ['Blocked', 'Health', 'Unavailable', 'Date'];
    for (const word of RED_PROOF) {
      const hits = offenders.filter((o) => o.includes(JSON.stringify(word)));
      if (hits.length) throw new Error(`red-proof still bare: ${word} → ${hits.join('; ')}`);
    }
    // To：短标签显式扫（长度 2 不进 ≥4 通扫）
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // 裸 'To' 作标签（非 t('…') 键名内）
      const bareTo = [...src.matchAll(/(?<![\w.])'To'(?![\w.])/g)];
      if (bareTo.length) {
        throw new Error(`${f}: bare 'To' label must use t('shell.html.to')`);
      }
    }

    // Copy setup 红证
    const connectSrc = readFileSync(join(root, 'pages/connect.js'), 'utf8');
    expect(literals(connectSrc).filter((s) => s === 'Copy setup')).toEqual([]);
    expect(connectSrc).toContain("t('connect.copy.copySetup')");

    expect(offenders).toEqual([]);

    // 负向三件：cookie / rel / value 右侧不得 t(
    const offendersAssign: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/document\.cookie\s*=\s*t\(/.test(src)) offendersAssign.push(`${f}: cookie=t(`);
      if (/\.rel\s*=\s*t\(/.test(src)) offendersAssign.push(`${f}: rel=t(`);
      if (/\.value\s*=\s*t\(/.test(src)) offendersAssign.push(`${f}: value=t(`);
    }
    expect(offendersAssign).toEqual([]);

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
    // 同族扫描：shell + connect 全部模板纯文本/option/aria/placeholder
    function loadTpl(file: string, constName: string): string {
      const src = readFileSync(join(import.meta.dir, '../src/ui', file), 'utf8');
      const m = src.match(
        new RegExp(`const ${constName} = ("(?:\\\\.|[^"\\\\])*")`),
      );
      if (!m) throw new Error(`template missing: ${file}:${constName}`);
      return JSON.parse(m[1]!);
    }
    const templates = [
      loadTpl('shell.ts', 'SHELL_HTML_TEMPLATE'),
      loadTpl('connect-shell.ts', 'CONNECT_NAV_TEMPLATE'),
      loadTpl('connect-shell.ts', 'CONNECT_PANEL_TEMPLATE'),
    ];

    /** 白名单：品牌 / 分页数字（非用户句子）；协议 value= 属性不在文本扫描内 */
    const TPL_ALLOW = new Set([
      'OpenAgent Home', // <title> 品牌
      'OpenAgent.email', // wordmark 品牌
      '20',
      '50',
      '100', // 分页 option 可见文本=协议数字
    ]);

    const leftover: string[] = [];
    for (const tpl of templates) {
      const texts = [
        ...[...tpl.matchAll(/>([^<{][^<]{0,200})</g)].map((x) => x[1]!),
        ...[...tpl.matchAll(/(?:aria-label|placeholder|title)="([^"{]*)"/g)].map(
          (x) => x[1]!,
        ),
        ...[...tpl.matchAll(/<option\b[^>]*>([^<]*)<\/option>/gi)].map(
          (x) => x[1]!,
        ),
      ]
        .map((s) => s.trim())
        .filter((s) => s.length >= 1 && /[A-Za-z]/.test(s));
      for (const s of texts) {
        if (TPL_ALLOW.has(s) || /^\d+$/.test(s)) continue;
        if (/^\{\{[\w.-]+\}\}$/.test(s)) continue;
        leftover.push(s);
      }
      // option 可见文本必须为槽（机械化：非槽非白名单即红）
      for (const m of tpl.matchAll(/<option\b[^>]*>([^<]*)<\/option>/gi)) {
        const body = m[1]!.trim();
        if (TPL_ALLOW.has(body) || /^\d+$/.test(body)) continue;
        if (!/^\{\{[\w.-]+\}\}$/.test(body)) {
          leftover.push(`option-body:${body}`);
        }
      }
    }
    expect([...new Set(leftover)]).toEqual([]);
  });

  test('R4.1：对抗自测 — $ 字面 / 转义 / 回落 / CJK / 赋值负向', () => {
    // ① withConnectShell：$ / $& / $$ / $1 字面插入，不 interpret
    // 注：文本位 HTML 转义后源串 $& → 输出 $&amp;（证明未被 replace 语义吞掉）
    const dollarDict: Record<string, string> = {
      'shell.html.connectAnAgent': 'Pay $1 now $$ and $& plus $` end',
      'shell.html.giveACodingAgentSecureAccess': 'Cost is $2 only',
    };
    const injected = withConnectShell(shellHtml('es', dollarDict), dollarDict);
    expect(injected).toContain('Pay $1 now $$ and $&amp; plus $` end');
    expect(injected).toContain('Cost is $2 only');
    // 旧工法 "$1"+nav 会把译文内 $1 当捕获组；回调工法下 $1/$$ 保持字面
    expect(injected).toContain('Pay $1 now');
    expect(injected.match(/\$1/g)?.length).toBeGreaterThanOrEqual(1);
    expect(injected.match(/\$\$/g)?.length).toBeGreaterThanOrEqual(1);

    // ② fillI18nSlots 译文含 $ 同样字面（回调替换）+ & 转义
    const slotDollar = fillI18nSlots('<p>{{login.title}}</p>', {
      'login.title': 'Price $1 / $$ / $&',
    });
    expect(slotDollar).toBe('<p>Price $1 / $$ / $&amp;</p>');

    // ③ HTML 特殊字符：文本位 + 属性位（衔接 R4-④，不削弱）
    const evil = `<>"'&`;
    expect(fillI18nSlots('<span>{{login.title}}</span>', { 'login.title': evil })).toBe(
      '<span>&lt;&gt;"\'&amp;</span>',
    );
    expect(
      fillI18nSlots('<input placeholder="{{shell.html.search}}">', {
        'shell.html.search': evil,
      }),
    ).toBe('<input placeholder="&lt;&gt;&quot;&#39;&amp;">');

    // ④ 空字典 / 缺键回落 en
    expect(fillI18nSlots('<b>{{login.submit}}</b>', {})).toBe(
      `<b>${I18N_EN['login.submit']}</b>`,
    );
    expect(fillI18nSlots('<b>{{login.submit}}</b>')).toBe(
      `<b>${I18N_EN['login.submit']}</b>`,
    );
    expect(renderUiHtml('es')).toEqual(renderUiHtml('en'));

    // ⑤ CJK 译文用例
    const cjk = renderUiHtml('zh-CN', {
      'login.submit': '登录',
      'shell.html.levelUrgent': '紧急',
    });
    expect(cjk).toContain('<html lang="zh-CN">');
    expect(cjk).toContain('登录');
    expect(cjk).toContain('>紧急<');
    expect(cjk).toContain('value="urgent"'); // 协议 value 不动

    // ⑥ 负向：document.cookie= / .rel= / .value= 右侧不得 t(
    const root = join(import.meta.dir, '../src/ui/client');
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (e.name.endsWith('.js')) acc.push(p);
      }
      return acc;
    };
    const offenders: string[] = [];
    for (const f of walk(root)) {
      const src = readFileSync(f, 'utf8');
      if (/document\.cookie\s*=\s*t\(/.test(src)) offenders.push(`${f}: cookie=t(`);
      if (/\.rel\s*=\s*t\(/.test(src)) offenders.push(`${f}: rel=t(`);
      if (/\.value\s*=\s*t\(/.test(src)) offenders.push(`${f}: value=t(`);
    }
    expect(offenders).toEqual([]);

    // ⑦ 通知级别 option：可见文本为槽，value 为协议常量
    const shellSrc = readFileSync(
      join(import.meta.dir, '../src/ui/shell.ts'),
      'utf8',
    );
    const tm = shellSrc.match(
      /const SHELL_HTML_TEMPLATE = ("(?:\\.|[^"\\])*")/,
    );
    const tpl: string = JSON.parse(tm![1]!);
    expect(tpl).toContain('value="urgent">{{shell.html.levelUrgent}}<');
    expect(tpl).toContain('value="normal">{{shell.html.levelNormal}}<');
    expect(tpl).toContain('value="low">{{shell.html.levelLow}}<');
    expect(I18N_EN['shell.html.levelUrgent']).toBe('urgent');
    expect(I18N_EN['shell.html.levelNormal']).toBe('normal');
    expect(I18N_EN['shell.html.levelLow']).toBe('low');
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

  /**
   * B-R2：API 协议令牌不得直渲为可见文案。
   * 可见文本走 t() 显示映射；data-* / 过滤仍保留协议值。
   * en 字典值 = 原令牌串（或既有展示串），en 输出逐字不变。
   */
  test('B-R2 P1-1：notifications 级别值过映射；data-tier 保留协议令牌', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/ui/client/pages/notifications.js'),
      'utf8',
    );
    // 两处渲染（日志 + 缓存）均经 notifyLevelLabel，禁止 row.level 直赋 textContent
    expect(src).toContain("tierValue.textContent = notifyLevelLabel(row.level)");
    expect(src).toContain("tierValue.textContent = notifyLevelLabel(tier)");
    expect(src).toContain("tierValue.setAttribute('data-tier', row.level || 'unknown')");
    expect(src).toContain("tierValue.setAttribute('data-tier', tier)");
    expect(src).not.toMatch(/tierValue\.textContent\s*=\s*row\.level/);
    expect(src).not.toMatch(/tierValue\.textContent\s*=\s*tier\s*[;)]/);

    // en 四值入字典；值=原令牌串
    for (const lv of ['urgent', 'normal', 'low', 'unknown'] as const) {
      expect(I18N_EN[`notifications.level.${lv}`]).toBe(lv);
    }

    // 运行时：可见文案走 t 键；缺键回落原令牌
    const helper = src.slice(
      src.indexOf('function notifyLevelLabel('),
      src.indexOf('function notifyTimeZone('),
    );
    const calls: string[] = [];
    const label = new Function(
      't',
      `${helper}\nreturn notifyLevelLabel;`,
    )((key: string) => {
      calls.push(key);
      return I18N_EN[key] || key;
    }) as (level: string | undefined) => string;
    expect(label('urgent')).toBe('urgent');
    expect(calls).toContain('notifications.level.urgent');
    expect(label(undefined)).toBe('unknown');
    expect(calls).toContain('notifications.level.unknown');
    // 缺键：t 回落 key 本身 → 回落原令牌
    const fallback = new Function(
      't',
      `${helper}\nreturn notifyLevelLabel;`,
    )((key: string) => key) as (level: string) => string;
    expect(fallback('custom-tier')).toBe('custom-tier');
  });

  test('B-R2 P1-2：tasks 全状态显示映射；data-state 保留协议令牌', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/ui/client/pages/tasks.js'),
      'utf8',
    );
    expect(src).toContain("badge.setAttribute('data-state', taskStateToken(task))");
    expect(src).toContain("badge.textContent = taskStateLabel(task)");
    expect(src).toContain("msgBadge.setAttribute('data-state', message.state || '')");
    expect(src).toContain("msgBadge.textContent = taskStateDisplay(message.state)");
    expect(src).toContain("msgBadge.textContent = taskStateDisplay('reminder')");

    // 六状态 + closed/reminder；input-required en=既有「Waiting for you」
    expect(I18N_EN['tasks.state.submitted']).toBe('submitted');
    expect(I18N_EN['tasks.state.working']).toBe('working');
    expect(I18N_EN['tasks.state.completed']).toBe('completed');
    expect(I18N_EN['tasks.state.failed']).toBe('failed');
    expect(I18N_EN['tasks.state.input-required']).toBe('Waiting for you');
    expect(I18N_EN['tasks.state.closed']).toBe('Closed');
    expect(I18N_EN['tasks.state.reminder']).toBe('reminder');

    const slice = src.slice(
      src.indexOf('function taskIsClosed('),
      src.indexOf('function syncTasksFilters('),
    );
    const calls: string[] = [];
    const helpers = new Function(
      't',
      `${slice}\nreturn { taskStateLabel, taskStateDisplay, taskStateToken };`,
    )((key: string) => {
      calls.push(key);
      return I18N_EN[key] || key;
    }) as {
      taskStateLabel: (task: { state?: string; result?: unknown; expiryProjection?: string }) => string;
      taskStateDisplay: (state: string) => string;
      taskStateToken: (task: { state?: string; result?: unknown; expiryProjection?: string }) => string;
    };

    expect(helpers.taskStateLabel({ state: 'submitted' })).toBe('submitted');
    expect(calls).toContain('tasks.state.submitted');
    expect(helpers.taskStateLabel({ state: 'working' })).toBe('working');
    expect(helpers.taskStateLabel({ state: 'completed' })).toBe('completed');
    expect(helpers.taskStateLabel({ state: 'failed' })).toBe('failed');
    expect(helpers.taskStateLabel({ state: 'input-required' })).toBe('Waiting for you');
    expect(helpers.taskStateToken({ state: 'input-required' })).toBe('input-required');
    expect(helpers.taskStateDisplay('reminder')).toBe('reminder');
    expect(helpers.taskStateDisplay('working')).toBe('working');
    // 协议 token 属性面：列表徽章 data-state 用 taskStateToken，非显示串
    expect(helpers.taskStateToken({ state: 'submitted' })).toBe('submitted');
    expect(helpers.taskStateLabel({ result: { closed_by_admin: true } })).toBe('Closed');
    expect(helpers.taskStateToken({ result: { closed_by_admin: true } })).toBe('closed');
  });

  test('B-R2 P1-3：push topicLabels 已知话题一律 t()；服务端英文 display 不作可见源', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/ui/client/pages/push-devices.js'),
      'utf8',
    );
    expect(src).toContain("parts.push(t('push.copy.userAlerts'))");
    expect(src).toContain("parts.push(t('push.copy.userLow'))");
    // 禁止把服务端 display 串当已知话题可见源
    expect(src).not.toMatch(/parts\.push\(String\(labels\.userAlerts\)\)/);
    expect(src).not.toMatch(/parts\.push\(labels\.userAlerts\)/);
    expect(src).not.toMatch(/parts\.push\(String\(labels\.userLow\)\)/);

    expect(I18N_EN['push.copy.userAlerts']).toBe('User alerts');
    expect(I18N_EN['push.copy.userLow']).toBe('User low');

    const helper = src.slice(
      src.indexOf('function topicSemantics('),
      src.indexOf('function paintDeviceQr('),
    );
    const calls: string[] = [];
    const topicSemantics = new Function(
      't',
      `${helper}\nreturn topicSemantics;`,
    )((key: string) => {
      calls.push(key);
      // 故意返回可区分串，证明未采用服务端英文
      if (key === 'push.copy.userAlerts') return 'ALERTS_VIA_T';
      if (key === 'push.copy.userLow') return 'LOW_VIA_T';
      return I18N_EN[key] || key;
    }) as (device: { topicLabels?: Record<string, string | boolean> }) => string;

    // 服务端给英文 display 时仍走 t()，不直推英文
    const out = topicSemantics({
      topicLabels: { userAlerts: 'User alerts', userLow: 'User low' },
    });
    expect(out).toBe('ALERTS_VIA_T · LOW_VIA_T');
    expect(calls).toContain('push.copy.userAlerts');
    expect(calls).toContain('push.copy.userLow');
    expect(out).not.toContain('User alerts');
    expect(out).not.toContain('User low');

    // 未知话题才原样显示
    const unknown = topicSemantics({
      topicLabels: { customTopic: 'Custom Channel Name' },
    });
    expect(unknown).toBe('Custom Channel Name');
  });
});
