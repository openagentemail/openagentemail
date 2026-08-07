import { describe, expect, test } from 'bun:test';
import {
  BARE_URL_RE,
  bareUrlSpans,
  CODE_KEYWORDS,
  extractCodes,
  extractHttpLinks,
  extractLinks,
  extractOtp,
  htmlToText,
  maskNormalizedHttpUrls,
  splitBareUrlCandidate,
  STRONG_OTP_CUES,
} from '../src/lib/otp.ts';

describe('htmlToText', () => {
  test('strips tags, scripts and styles, keeps readable text', () => {
    const html = `<html><head><style>body{color:red}</style></head>
      <body><p>Hello <b>agent</b>,</p><script>alert(1)</script>
      <p>Your code is <b>123456</b></p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Hello agent');
    expect(text).toContain('Your code is 123456');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('<b>');
  });

  test('decodes entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3&nbsp;!</p>')).toBe('Tom & Jerry <3 !');
  });

  // 任何人都能给身份地址发信，所以恶意 HTML 绝不能让读信路径抛异常：
  // 一封投毒邮件会让 GET /v1/messages/:id 500，并让命中过滤器的 wait_for
  // 一直空转到超时。
  describe('malformed numeric entities must not throw', () => {
    test('十进制码点越界', () => {
      expect(() => htmlToText('<p>your code &#99999999; 123456</p>')).not.toThrow();
    });

    test('十六进制码点越界', () => {
      expect(() => htmlToText('<p>your code &#xFFFFFFFF; 123456</p>')).not.toThrow();
    });

    test('超长数字（Number() 溢出成 Infinity）', () => {
      expect(() => htmlToText(`<p>&#${'9'.repeat(400)};</p>`)).not.toThrow();
    });

    test('越界实体被丢弃，不会被当成验证码提取出来', () => {
      const otp = extractOtp('', '<p>Your verification code &#99999999; is 123456</p>');
      expect(otp.codes).toEqual(['123456']);
    });

    test('合法实体照常解码（U+1F600 等星光面字符）', () => {
      expect(htmlToText('<p>&#128512;&#x1F600;</p>')).toBe('\u{1F600}\u{1F600}');
    });

    test('孤立代理项不会漏进输出', () => {
      expect(htmlToText('<p>a&#55296;b</p>')).toBe('ab');
    });
  });
});

describe('extractCodes', () => {
  test('finds a 6-digit code near "verification code"', () => {
    const text = 'Your verification code is 483920. It expires in 10 minutes.';
    expect(extractCodes(text)).toEqual(['483920']);
  });

  test('finds code in typical HTML-stripped signup mail', () => {
    const text = htmlToText(
      '<p>Welcome!</p><p>Enter this code to confirm your account:</p><h1>7821</h1>',
    );
    expect(extractCodes(text)).toEqual(['7821']);
  });

  test('finds 8-digit codes', () => {
    expect(extractCodes('Your one-time passcode: 91827364')).toEqual(['91827364']);
  });

  test('finds 4-digit codes', () => {
    expect(extractCodes('OTP: 0042 — do not share it.')).toEqual(['0042']);
  });

  test('finds Chinese 验证码', () => {
    expect(extractCodes('【Example】您的验证码是 884216，五分钟内有效。')).toEqual(['884216']);
  });

  test('finds 动态码', () => {
    expect(extractCodes('动态码 3377 用于登录验证')).toEqual(['3377']);
  });

  test('ignores digit runs without a keyword nearby', () => {
    expect(extractCodes('Order #12345678 shipped on Monday.')).toEqual([]);
    expect(extractCodes('Call us at 5551234 anytime.')).toEqual([]);
  });

  test('years need strong OTP cues, not mere verification (F62/F65)', () => {
    // Strong cue \bpin\b — still extract (F62 Codex / F65 keep).
    expect(extractCodes('Your verification PIN is 2026')).toEqual(['2026']);
    // "verification" alone is not strong enough (F65 restores year guard).
    expect(extractCodes('Our verification team, since 2024, sends regards.')).toEqual([]);
    expect(extractCodes('Read our identity verification roadmap for 2026')).toEqual([]);
    // Substring "pin" inside "shopping" must not count (\bpin\b).
    expect(extractCodes('shopping 2026 deals')).toEqual([]);
  });

  test('years without any OTP keyword stay unextracted (F62)', () => {
    expect(extractCodes('Born 1990, see link')).toEqual([]);
    expect(extractCodes('This week in tech: 2024 trends.')).toEqual([]);
  });

  test('delimited OTP forms need strong cues (F68)', () => {
    expect(extractCodes('Your verification code is 123-456')).toEqual(['123-456']);
    // Full form only — continuous 4-digit halves of a delimited shape are suppressed.
    expect(extractCodes('Your PIN is 1234-5678')).toEqual(['1234-5678']);
    // Longer continuous runs are not delimited halves; keep continuous extract.
    expect(extractCodes('Your code is 123456-7890')).toEqual(['123456', '7890']);
    expect(extractCodes('code 1234-567890')).toEqual(['1234', '567890']);
    // Other separators with strong cues.
    expect(extractCodes('Your OTP is 123–456')).toEqual(['123–456']);
    expect(extractCodes('验证码 123-456')).toEqual(['123-456']);
    // No strong cue: roadmap ranges and phone-like numbers stay out.
    expect(extractCodes('roadmap 2024-2025')).toEqual([]);
    expect(extractCodes('call 555-1234')).toEqual([]);
  });

  test('strong cues cover CJK/JP code words for delimited and years (F71)', () => {
    expect(extractCodes('您的校验码是 123-456')).toEqual(['123-456']);
    expect(extractCodes('確認コードは 123-456')).toEqual(['123-456']);
    expect(extractCodes('認証コードは 123-456')).toEqual(['123-456']);
    // Year path benefits from the same strong set.
    expect(extractCodes('認証コード 2026')).toEqual(['2026']);
    // Weak verification alone still does not unlock years.
    expect(extractCodes('verification roadmap 2026')).toEqual([]);
  });

  test('STRONG_OTP_CUES stays aligned with CODE_KEYWORDS strong items (F71)', () => {
    const strongSet = new Set<string>(STRONG_OTP_CUES);
    const codeSet = new Set<string>(CODE_KEYWORDS);
    const latinStrong = new Set(['code', 'otp', 'passcode', 'pin']);
    for (const kw of CODE_KEYWORDS) {
      const mustBeStrong = latinStrong.has(kw) || /码|コード/.test(kw);
      if (mustBeStrong) {
        expect(strongSet.has(kw)).toBe(true);
      }
    }
    // No orphan strong cues outside the keyword list.
    for (const cue of STRONG_OTP_CUES) {
      expect(codeSet.has(cue)).toBe(true);
    }
    // Weak / action terms must remain outside the strong set.
    for (const weak of [
      'verification',
      'verify',
      'confirmation',
      'one-time',
      'one time',
      'security code',
    ] as const) {
      expect(strongSet.has(weak)).toBe(false);
      expect(codeSet.has(weak)).toBe(true);
    }
  });

  test('multi-character separator runs extract delimited OTP (F72)', () => {
    expect(extractCodes('Your code is 123 - 456')).toEqual(['123 - 456']);
    expect(extractCodes('Your code is 123  456')).toEqual(['123  456']);
    expect(extractCodes('Your code is 123 – 456')).toEqual(['123 – 456']);
    expect(extractCodes('123 - 456')).toEqual([]);
    // Half-suppression with multi-char seps.
    expect(extractCodes('Your code is 1234 - 5678')).toEqual(['1234 - 5678']);
    // Four+ seps intentionally miss (bounded false-positive surface).
    expect(extractCodes('Your code is 123    456')).toEqual([]);
  });

  test('three digit-group delimited OTP extracts with original spelling (F73)', () => {
    expect(extractCodes('Your code is 12 34 56')).toEqual(['12 34 56']);
    expect(extractCodes('Your PIN is 12-34-56')).toEqual(['12-34-56']);
    // Two-group short halves still work (2+2).
    expect(extractCodes('Your code is 12 34')).toEqual(['12 34']);
    // Continuous left half suppressed when right group is only 2 digits.
    expect(extractCodes('Your code is 1234 - 56')).toEqual(['1234 - 56']);
    // F68 long continuous regression: not one delimited form.
    expect(extractCodes('Your code is 123456-7890')).toEqual(['123456', '7890']);
    // No strong cue / roadmap range.
    expect(extractCodes('12 34 56')).toEqual([]);
    expect(extractCodes('roadmap 2024-2025')).toEqual([]);
    expect(extractCodes('call 555-12')).toEqual([]);
  });

  test('four digit-group form extracts whole; five+ groups rejected (F74)', () => {
    expect(extractCodes('Your verification code is 12 34 56 78')).toEqual(['12 34 56 78']);
    expect(extractCodes('Your PIN is 12-34-56-78')).toEqual(['12-34-56-78']);
    // 5+ groups: no prefix/suffix partial matches.
    expect(extractCodes('Your code is 12 34 56 78 90')).toEqual([]);
    // F73/F68 regressions.
    expect(extractCodes('Your code is 12 34 56')).toEqual(['12 34 56']);
    expect(extractCodes('Your code is 123-456')).toEqual(['123-456']);
    // Trailing incomplete group: full-run integrity rejects partial prefix.
    // (Previously F73 could yield ['123-456'] from '123-456-7'.)
    expect(extractCodes('Your code is 123-456-7')).toEqual([]);
  });

  test('Unicode decimal digits extract with original spelling (F75)', () => {
    // Fullwidth continuous + CJK cue.
    expect(extractCodes('您的验证码是 １２３４５６')).toEqual(['１２３４５６']);
    // Fullwidth hyphen separator (U+FF0D).
    expect(extractCodes('您的验证码是 １２３\uFF0D４５６')).toEqual(['１２３\uFF0D４５６']);
    // Arabic-Indic (U+0660…) and Persian/Extended Arabic-Indic (U+06F0…).
    expect(extractCodes('Your code is \u0661\u0662\u0663\u0664\u0665\u0666')).toEqual([
      '\u0661\u0662\u0663\u0664\u0665\u0666',
    ]);
    expect(extractCodes('Your code is \u06F1\u06F2\u06F3\u06F4\u06F5\u06F6')).toEqual([
      '\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6',
    ]);
    // Fullwidth parens are non-alnum → bounds hold.
    expect(extractCodes('验证码（１２３４５６）')).toEqual(['１２３４５６']);
    // CJK glued to ASCII digits still works (must not regress: no \\p{L} in bounds).
    expect(extractCodes('您的验证码是123456')).toEqual(['123456']);
    // Latin letter glued → reject (same as old \\b).
    expect(extractCodes('code abc１２３４５６')).toEqual([]);
    expect(extractCodes('code １２３４５６x')).toEqual([]);
  });

  test('Unicode-space delimited OTP extracts with original spelling (F70)', () => {
    const nbsp = '\u00A0';
    const nnbsp = '\u202F';
    const emsp = '\u2003';
    expect(extractCodes(`Your verification code is 123${nbsp}456`)).toEqual([`123${nbsp}456`]);
    expect(extractCodes(`Your PIN is 123${nnbsp}456`)).toEqual([`123${nnbsp}456`]);
    expect(extractCodes(`Your OTP is 123${emsp}456`)).toEqual([`123${emsp}456`]);
    // Half-suppression still applies with Unicode separators.
    expect(extractCodes(`Your code is 1234${nbsp}5678`)).toEqual([`1234${nbsp}5678`]);
    // No strong cue → skip.
    expect(extractCodes(`call 555${nbsp}1234`)).toEqual([]);
    // Newlines must not act as separators (meta/text joins use \n).
    expect(extractCodes('Your verification code is 123\n456')).toEqual([]);
    expect(extractCodes('Your verification code is 1234\n5678')).toEqual(['1234', '5678']);
    expect(extractCodes('Your verification code is 123\r456')).toEqual([]);
  });

  test('dedupes repeated codes', () => {
    expect(extractCodes('code 552211. Again: your code is 552211.')).toEqual(['552211']);
  });
});

describe('extractLinks', () => {
  test('matches verify in URL', () => {
    const links = extractLinks('Click https://example.com/verify?token=abc to continue');
    expect(links).toEqual(['https://example.com/verify?token=abc']);
  });

  test('matches reset/confirm/activate/login/signin in URL', () => {
    const text = [
      'https://a.example.com/password/reset?token=1',
      'https://b.example.com/confirm_email?token=2',
      'https://c.example.com/activate/3',
      'https://d.example.com/login?token=4',
      'https://e.example.com/signin/magic/5',
      'https://f.example.com/pricing',
    ].join('\n');
    const links = extractLinks(text);
    expect(links).toHaveLength(5);
    expect(links).not.toContain('https://f.example.com/pricing');
  });

  test('matches on anchor text when the URL is neutral', () => {
    const html = '<p><a href="https://example.com/e/abc123">Verify your email address</a></p>';
    const links = extractLinks(htmlToText(html), html);
    expect(links).toEqual(['https://example.com/e/abc123']);
  });

  test('strips trailing punctuation from bare URLs', () => {
    const links = extractLinks('Open https://example.com/confirm?x=1.');
    expect(links).toEqual(['https://example.com/confirm?x=1']);
  });

  // 真实邮件的 href 里 & 一律写成 &amp;（HTML 规范要求）。不还原的话，
  // agent 拿到的验证链接会带着字面量 "&amp;"，多数服务端会判参数非法。
  test('decodes entities inside the href', () => {
    const html =
      '<a href="https://app.example.com/verify?token=abc&amp;uid=42&#38;sig=zz">Verify your email</a>';
    expect(extractLinks(htmlToText(html), html)).toEqual([
      'https://app.example.com/verify?token=abc&uid=42&sig=zz',
    ]);
  });

  test('trims whitespace around the href', () => {
    const html = '<a href="  https://app.example.com/confirm?x=1  ">Confirm</a>';
    expect(extractLinks(htmlToText(html), html)).toEqual(['https://app.example.com/confirm?x=1']);
  });

  // href 解码必须建立在实体解码器已经防越界之后（blueprint 2），否则一封
  // "有纯文本正文 + 锚点 href 里带越界实体"的邮件会在这里抛 RangeError。
  test('href 里的越界实体不会把提取过程打崩', () => {
    const html = '<a href="https://x.example/verify?u=1&#99999999;">Verify your email</a>';
    expect(() => extractOtp('Please confirm your address.', html)).not.toThrow();
    expect(extractOtp('Please confirm your address.', html).links).toEqual([
      'https://x.example/verify?u=1',
    ]);
  });

  test('returns empty for unrelated links only', () => {
    expect(extractLinks('Docs at https://example.com/docs and https://example.com/about')).toEqual([]);
  });

  test('bareUrlSpans stays linear on free brackets and dense adjacent candidates', () => {
    const freeBrackets = `https://${'['.repeat(10_000)}`;
    const nestedParens = `https://x.com/${'('.repeat(5_000)}${')'.repeat(5_000)}`;
    // 8000 tight Markdown-chain cuts `)(` (~200KB) must stay O(n).
    const dense = Array.from(
      { length: 8_000 },
      (_, i) => `https://a${i}.example/verify`,
    ).join(')(');
    const started = performance.now();
    freeBrackets.match(BARE_URL_RE);
    [...bareUrlSpans(freeBrackets)];
    [...bareUrlSpans(nestedParens)];
    const denseSpans = [...bareUrlSpans(dense)];
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(denseSpans).toHaveLength(8_000);
  });

  test('splitBareUrlCandidate keeps nested balanced parens and peels free trailers', () => {
    expect(splitBareUrlCandidate('https://example.com/confirm(foo(bar))?token=secret')).toEqual({
      clean: 'https://example.com/confirm(foo(bar))?token=secret',
      trail: '',
    });
    expect(splitBareUrlCandidate('https://example.com/verify?token=a)')).toEqual({
      clean: 'https://example.com/verify?token=a',
      trail: ')',
    });
    expect(splitBareUrlCandidate('https://example.com/verify?token=a).')).toEqual({
      clean: 'https://example.com/verify?token=a',
      trail: ').',
    });
    expect(splitBareUrlCandidate('https://example.com/verify?token=a.)')).toEqual({
      clean: 'https://example.com/verify?token=a',
      trail: '.)',
    });
    expect(splitBareUrlCandidate('https://[2001:db8::1]/confirm?token=secret')).toEqual({
      clean: 'https://[2001:db8::1]/confirm?token=secret',
      trail: '',
    });
    // Apostrophe is a legal URL char; only an odd trailing prose closer peels.
    expect(splitBareUrlCandidate("https://example.com/confirm?'token=secret")).toEqual({
      clean: "https://example.com/confirm?'token=secret",
      trail: '',
    });
    expect(splitBareUrlCandidate("https://x.com/it's")).toEqual({
      clean: "https://x.com/it's",
      trail: '',
    });
    expect(splitBareUrlCandidate("https://example.com/verify?token=a'")).toEqual({
      clean: 'https://example.com/verify?token=a',
      trail: "'",
    });
    expect(splitBareUrlCandidate("https://example.com/verify?token=a'.")).toEqual({
      clean: 'https://example.com/verify?token=a',
      trail: "'.",
    });
    // Mid-string free closer between adjacent Markdown links (glued next scheme).
    expect(
      splitBareUrlCandidate(
        'https://a.example/verify)[Confirm](https://b.example/confirm',
      ),
    ).toEqual({
      clean: 'https://a.example/verify',
      trail: ')[Confirm](https://b.example/confirm',
    });
    // Unbalanced ) with no following scheme is URL content (WHATWG), not a cut.
    expect(splitBareUrlCandidate('https://example.com/confirm)foo?token=secret')).toEqual({
      clean: 'https://example.com/confirm)foo?token=secret',
      trail: '',
    });
  });

  test('HTML anchor hrefs keep a literal trailing ) that prose trim would peel', () => {
    const html =
      '<a href="https://example.com/confirm?token=abc)">Confirm your account</a>';
    expect(extractLinks('Confirm your account', html)).toEqual([
      'https://example.com/confirm?token=abc)',
    ]);
    // Prose path still peels free trailers.
    expect(extractHttpLinks('(see https://x.com/a)')).toEqual(['https://x.com/a']);
  });

  test('adjacent Markdown links split into two bare spans and mask fully', () => {
    const text = '[Verify](https://a.example/verify)[Confirm](https://b.example/confirm)';
    const spans = [...bareUrlSpans(text)].map((s) => s.clean);
    expect(spans).toEqual([
      'https://a.example/verify',
      'https://b.example/confirm',
    ]);
    expect(extractHttpLinks(text)).toEqual([
      'https://a.example/verify',
      'https://b.example/confirm',
    ]);
    // Monster merge must not appear as a single extracted URL.
    expect(extractHttpLinks(text).join(' ')).not.toContain(')[Confirm](');
    const masked = maskNormalizedHttpUrls(text, extractHttpLinks(text));
    // Glue `)[Confirm](` is redacted with the URLs (F54) so labels cannot leak secrets.
    expect(masked).toBe('[Verify](•••••••••)');
    expect(masked).not.toContain('a.example');
    expect(masked).not.toContain('b.example');
    expect(masked).not.toContain('https://');
    expect(masked).not.toContain('Confirm');
  });

  test('unbalanced ) without a glued next scheme stays inside the URL', () => {
    const url = 'https://example.com/confirm)foo?token=secret';
    expect(extractHttpLinks(url)).toEqual([url]);
    expect(maskNormalizedHttpUrls(`See ${url}`, [url])).toBe('See •••');
  });

  test('nested ?next=https:// after unbalanced ) stays one span (F45)', () => {
    // Old glue (no-whitespace-to-next-scheme) hard-cut at ) and leaked token=.
    const text =
      'Verify https://example.com/confirm)token=secret?next=https://safe.example/';
    const full =
      'https://example.com/confirm)token=secret?next=https://safe.example/';
    const spans = [...bareUrlSpans(text)];
    expect(spans).toHaveLength(1);
    expect(spans[0]!.clean).toBe(full);
    expect(extractHttpLinks(text)).toEqual([full]);
    const masked = maskNormalizedHttpUrls(text, extractHttpLinks(text));
    expect(masked).toBe('Verify •••');
    expect(masked).not.toContain('token');
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('https://');
  });

  test('tight Markdown chain glue )[ and )( still splits adjacent URLs', () => {
    const md = '[a](https://x.example/pay)[b](https://y.example/confirm)';
    expect([...bareUrlSpans(md)].map((s) => s.clean)).toEqual([
      'https://x.example/pay',
      'https://y.example/confirm',
    ]);
    expect(maskNormalizedHttpUrls(md, extractHttpLinks(md))).toBe('[a](•••••••••)');

    const tight = 'https://x.example/a)(https://y.example/b';
    expect([...bareUrlSpans(tight)].map((s) => s.clean)).toEqual([
      'https://x.example/a',
      'https://y.example/b',
    ]);
    // glue is `)(` → three placeholders concatenated
    expect(maskNormalizedHttpUrls(tight, extractHttpLinks(tight))).toBe('•••••••••');

    const bracketChain = '[https://x.example/a][https://y.example/b]';
    expect([...bareUrlSpans(bracketChain)].map((s) => s.clean)).toEqual([
      'https://x.example/a',
      'https://y.example/b',
    ]);
  });

  test('nested ?next= scheme does not hide following Markdown chain (F52)', () => {
    const text =
      '[Verify](https://a.example/verify?next=https://x.example/)[Confirm](https://b.example/confirm)';
    expect([...bareUrlSpans(text)].map((s) => s.clean)).toEqual([
      'https://a.example/verify?next=https://x.example/',
      'https://b.example/confirm',
    ]);
    expect(extractHttpLinks(text)).toEqual([
      'https://a.example/verify?next=https://x.example/',
      'https://b.example/confirm',
    ]);
    expect(maskNormalizedHttpUrls(text, extractHttpLinks(text))).toBe('[Verify](•••••••••)');
  });

  test('Markdown chain glue between URLs is redacted with the links (F54)', () => {
    const text =
      'Verify https://example.com/confirm)[token=secret](https://safe.example/)';
    const links = extractHttpLinks(text);
    expect(links).toEqual([
      'https://example.com/confirm',
      'https://safe.example/',
    ]);
    const spans = [...bareUrlSpans(text)];
    expect(spans).toHaveLength(2);
    expect(spans[0]!.glueAfter).toEqual({
      start: text.indexOf(')[token=secret]('),
      end: text.indexOf('https://safe.example/'),
    });
    const masked = maskNormalizedHttpUrls(text, links);
    // Trailing Markdown `)` after the second URL stays; glue+URLs are placeholders.
    expect(masked).toBe('Verify •••••••••)');
    expect(masked).not.toContain('token');
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('https://');
    expect(masked).not.toContain('example.com');
  });

  test('glue redacts when only one adjacent URL is a target (F54)', () => {
    const text =
      'Verify https://example.com/confirm)[token=secret](https://safe.example/)';
    const onlyFirst = maskNormalizedHttpUrls(text, ['https://example.com/confirm']);
    expect(onlyFirst).not.toContain('token');
    expect(onlyFirst).not.toContain('secret');
    expect(onlyFirst).toContain('safe.example');

    const onlySecond = maskNormalizedHttpUrls(text, ['https://safe.example/']);
    expect(onlySecond).not.toContain('token');
    expect(onlySecond).not.toContain('secret');
    expect(onlySecond).toContain('example.com/confirm');
  });

  test('quote/angle hard-cut tails are redacted with the URL (F55)', () => {
    // Codex original: " after confirm hard-cuts; tail must not leak.
    const q = 'Verify https://example.com/confirm"token=secret';
    expect(extractHttpLinks(q)).toEqual(['https://example.com/confirm']);
    const qSpans = [...bareUrlSpans(q)];
    expect(qSpans).toHaveLength(1);
    expect(qSpans[0]!.tailAfter).toEqual({
      start: q.indexOf('"token=secret'),
      end: q.length,
    });
    const qMasked = maskNormalizedHttpUrls(q, extractHttpLinks(q));
    expect(qMasked).toBe('Verify ••••••');
    expect(qMasked).not.toContain('token');
    expect(qMasked).not.toContain('secret');

    // > glued tail
    const gt = 'Verify https://example.com/confirm>token=secret';
    expect(maskNormalizedHttpUrls(gt, extractHttpLinks(gt))).toBe('Verify ••••••');
    expect(maskNormalizedHttpUrls(gt, extractHttpLinks(gt))).not.toContain('token');

    // <url>token=secret — closer > glued to tail
    const lt = 'See <https://example.com/confirm>token=secret';
    const ltMasked = maskNormalizedHttpUrls(lt, extractHttpLinks(lt));
    expect(ltMasked).toBe('See <••••••');
    expect(ltMasked).not.toContain('token');
    expect(ltMasked).not.toContain('secret');

    // Balanced quote: whitespace after closer → no tail; delimiters stay.
    const bal = 'Say "https://example.com/confirm" end';
    expect(maskNormalizedHttpUrls(bal, extractHttpLinks(bal))).toBe('Say "•••" end');

    // Autolink with space after >
    const auto = 'See <https://example.com/confirm> end';
    expect(maskNormalizedHttpUrls(auto, extractHttpLinks(auto))).toBe('See <•••> end');

    // Apostrophe stays inside URL (whole span masked).
    const ap = "See https://example.com/confirm'token=secret";
    expect(extractHttpLinks(ap)).toEqual(["https://example.com/confirm'token=secret"]);
    expect(maskNormalizedHttpUrls(ap, extractHttpLinks(ap))).toBe('See •••');

    // Tail contains a scheme: stop tail at that scheme; second URL independent.
    const nested = 'Verify https://a.example/x"https://b.example/y';
    const nestedSpans = [...bareUrlSpans(nested)];
    expect(nestedSpans.map((s) => s.clean)).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
    expect(nestedSpans[0]!.tailAfter).toEqual({
      start: nested.indexOf('"https://'),
      end: nested.indexOf('https://b.example/y'),
    });
    const nestedMasked = maskNormalizedHttpUrls(nested, extractHttpLinks(nested));
    expect(nestedMasked).toBe('Verify •••••••••');
    expect(nestedMasked).not.toContain('a.example');
    expect(nestedMasked).not.toContain('b.example');

    // F54 glue still works alongside F55 (no cross-regression).
    const glue =
      'Verify https://example.com/confirm)[token=secret](https://safe.example/)';
    expect(maskNormalizedHttpUrls(glue, extractHttpLinks(glue))).not.toContain('token');
  });

  test('invalid nested scheme after tail/glue is swallowed into redaction (F57)', () => {
    // Codex: tail stops at nested scheme; nested span is invalid and must not leak.
    const text = 'Verify https://example.com/confirm"x=https://[token=secret';
    const links = extractHttpLinks(text);
    expect(links).toEqual(['https://example.com/confirm']);
    const masked = maskNormalizedHttpUrls(text, links);
    expect(masked).not.toContain('token');
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('https://[');
    expect(masked.startsWith('Verify •••')).toBe(true);

    // Chain of invalid nested schemes after quote tails.
    const chain =
      'See https://example.com/a"x=https://[bad"y=https://[worse';
    const chainMasked = maskNormalizedHttpUrls(chain, extractHttpLinks(chain));
    expect(chainMasked).not.toContain('bad');
    expect(chainMasked).not.toContain('worse');
    expect(chainMasked).not.toContain('https://[');
    expect(chainMasked).not.toContain('token');

    // Tail stops at a *valid* scheme that is not a mask target — leave it visible.
    const keep =
      'See https://a.example/x"https://b.example/visible';
    const keepMasked = maskNormalizedHttpUrls(keep, ['https://a.example/x']);
    expect(keepMasked).toContain('b.example/visible');
    expect(keepMasked).not.toContain('a.example/x');

    // Glue cut onto an invalid nested scheme — same swallow path.
    const glueBad = 'See https://example.com/confirm)[x](https://[token=secret';
    const glueMasked = maskNormalizedHttpUrls(glueBad, extractHttpLinks(glueBad));
    expect(glueMasked).not.toContain('token');
    expect(glueMasked).not.toContain('secret');
    expect(glueMasked).not.toContain('https://[');
  });

  test('Markdown link closer cuts free ) before glued prose (F59)', () => {
    const text = '[Verify](https://example.com/confirm)now';
    expect([...bareUrlSpans(text)].map((s) => s.clean)).toEqual([
      'https://example.com/confirm',
    ]);
    expect(extractHttpLinks(text)).toEqual(['https://example.com/confirm']);
    expect(maskNormalizedHttpUrls(text, extractHttpLinks(text))).toBe(
      '[Verify](•••)now',
    );

    expect(
      [...bareUrlSpans('[x](https://a.com/f(1))tail')].map((s) => s.clean),
    ).toEqual(['https://a.com/f(1)']);
    expect(
      [...bareUrlSpans('[x](https://a.com/p)foo)bar')].map((s) => s.clean),
    ).toEqual(['https://a.com/p']);

    // Space after MD closer — still clean URL (peel/cut both fine).
    expect(
      extractHttpLinks('[Verify](https://example.com/confirm) now'),
    ).toEqual(['https://example.com/confirm']);
    expect(extractHttpLinks('[Verify](https://example.com/confirm)')).toEqual([
      'https://example.com/confirm',
    ]);

    // Bare URL free ) path must not use MD-link cutting (F48).
    const bare = 'Verify https://example.com/confirm)[token=secret';
    expect([...bareUrlSpans(bare)].map((s) => s.clean)).toEqual([
      'https://example.com/confirm)[token=secret',
    ]);
  });

  test('dense quote-tail fragments stay linear (F58)', () => {
    // 4000 glued fragments: each "x= before the next https:// must not O(n²) scan.
    const n = 4_000;
    const dense = Array.from(
      { length: n },
      (_, i) => `https://a.example/${i}"x=`,
    ).join('');
    const started = performance.now();
    const spans = [...bareUrlSpans(dense)];
    const elapsed = performance.now() - started;
    expect(spans).toHaveLength(n);
    expect(spans[0]!.clean).toBe('https://a.example/0');
    expect(spans[n - 1]!.clean).toBe(`https://a.example/${n - 1}`);
    // Last fragment has no following scheme → tail may extend over "x=
    expect(spans[0]!.tailAfter?.end).toBe(spans[1]!.start);
    expect(elapsed).toBeLessThan(5_000);
    // Masking must remain linear as well.
    const maskStarted = performance.now();
    const masked = maskNormalizedHttpUrls(dense, extractHttpLinks(dense));
    expect(performance.now() - maskStarted).toBeLessThan(5_000);
    expect(masked).not.toContain('https://');
    expect(masked).not.toContain('a.example');
  });

  test('path segment )[token= is one WHATWG URL, not a Markdown cut (F48)', () => {
    const text = 'Verify https://example.com/confirm)[token=secret';
    const full = 'https://example.com/confirm)[token=secret';
    const spans = [...bareUrlSpans(text)];
    expect(spans).toHaveLength(1);
    expect(spans[0]!.clean).toBe(full);
    expect(extractHttpLinks(text)).toEqual([full]);
    const masked = maskNormalizedHttpUrls(text, extractHttpLinks(text));
    expect(masked).toBe('Verify •••');
    expect(masked).not.toContain('token');
    expect(masked).not.toContain('secret');

    // Mixed: nested scheme after path junk still one span (scheme not after ]().
    const mixed =
      'See https://example.com/confirm)[token=secret?next=https://safe.example/';
    const mixedFull =
      'https://example.com/confirm)[token=secret?next=https://safe.example/';
    expect([...bareUrlSpans(mixed)].map((s) => s.clean)).toEqual([mixedFull]);
    expect(maskNormalizedHttpUrls(mixed, extractHttpLinks(mixed))).toBe('See •••');
  });

  test('space- or comma-separated adjacent URLs split without glue', () => {
    expect(extractHttpLinks('https://a.example/v https://b.example/c')).toEqual([
      'https://a.example/v',
      'https://b.example/c',
    ]);
    expect(extractHttpLinks('https://a.example/v, https://b.example/c')).toEqual([
      'https://a.example/v',
      'https://b.example/c',
    ]);
  });

  test('bareUrlSpans stays linear when many unbalanced closers precede whitespace', () => {
    // Unbalanced ) with non-adjacent next scheme stays in-URL (O(n) depth walk + peel).
    const adversarial =
      `https://a.example/path${')'.repeat(40_000)} https://b.example/other`;
    const started = performance.now();
    const links = extractHttpLinks(adversarial);
    expect(performance.now() - started).toBeLessThan(1_000);
    // Free trailing ) peel leaves path; second URL still found after whitespace.
    expect(links).toEqual(['https://a.example/path', 'https://b.example/other']);
  });

  test('JS whitespace (NBSP, em space) ends a bare URL candidate', () => {
    const nbsp = `https://example.com/verify?token=abc\u00A0NEXT`;
    expect(extractHttpLinks(nbsp)).toEqual(['https://example.com/verify?token=abc']);
    expect(extractHttpLinks(nbsp)[0]).not.toContain('%C2%A0');
    const em = `https://example.com/verify?token=abc\u2003NEXT`;
    expect(extractHttpLinks(em)).toEqual(['https://example.com/verify?token=abc']);
  });

  test('outer single quotes peel even with internal apostrophes (F61)', () => {
    const text = "Use 'https://example.com/verify/o'brien' now";
    expect(extractHttpLinks(text)).toEqual(["https://example.com/verify/o'brien"]);
    expect(maskNormalizedHttpUrls(text, extractHttpLinks(text))).toBe("Use '•••' now");

    // Trailing prose punctuation after outer closer still peels the quote (even count).
    expect(extractHttpLinks("See 'https://example.com/verify/o'brien'.")).toEqual([
      "https://example.com/verify/o'brien",
    ]);

    // Balanced outer quotes without internal apostrophe — still peel closer.
    expect(extractHttpLinks("'https://a.com/x'")).toEqual(['https://a.com/x']);

    // Bare URL with trailing ' and even/odd count: no openQuoted (start===0 path via split).
    expect(splitBareUrlCandidate("https://a.com/x'")).toEqual({
      clean: 'https://a.com/x',
      trail: "'",
    });
    // Even trailing '' without openQuoted: leave both (parity even).
    expect(splitBareUrlCandidate("https://a.com/x''")).toEqual({
      clean: "https://a.com/x''",
      trail: '',
    });
  });

  test('openQuoted peels only one closing quote (F63)', () => {
    // URL legitimately ends with ' + outer prose quote → keep URL-terminal '.
    const text = "Use 'https://example.com/verify/token'' now";
    expect(extractHttpLinks(text)).toEqual(["https://example.com/verify/token'"]);
    expect(maskNormalizedHttpUrls(text, extractHttpLinks(text))).toBe("Use '•••' now");
  });

  test('prose wrappers cut before closing punctuation (F64)', () => {
    expect(extractHttpLinks('Visit (https://example.com/verify): now')).toEqual([
      'https://example.com/verify',
    ]);
    expect(extractHttpLinks("Use 'https://example.com/verify'!")).toEqual([
      'https://example.com/verify',
    ]);
    expect(
      [...bareUrlSpans('(https://a.com/f(1))')].map((s) => s.clean),
    ).toEqual(['https://a.com/f(1)']);
    expect(extractHttpLinks("'https://a.com/x',")).toEqual(['https://a.com/x']);
    // URL-terminal ' kept; outer closer cut on whitespace (F63 + F64).
    expect(extractHttpLinks("See 'https://example.com/verify/token'' now")).toEqual([
      "https://example.com/verify/token'",
    ]);
  });

  test('prose brackets cut before free closing ] (F67)', () => {
    expect(extractHttpLinks('Visit [https://example.com/verify]: now')).toEqual([
      'https://example.com/verify',
    ]);
    // Free-`]` cut (not only peel): `!` / glued tail are not trailer peel chars.
    expect(extractHttpLinks('Visit [https://example.com/verify]!')).toEqual([
      'https://example.com/verify',
    ]);
    expect(
      [...bareUrlSpans('[https://example.com/verify]token=secret')].map((s) => s.clean),
    ).toEqual(['https://example.com/verify']);
    // Balanced paren inside still peels outer brackets.
    expect(extractHttpLinks('[https://a.com/f(1)]')).toEqual(['https://a.com/f(1)']);
    // Nested brackets: inner [1] is balanced; free outer ] cuts.
    expect(
      [...bareUrlSpans('[https://a.com/f[1]]')].map((s) => s.clean),
    ).toEqual(['https://a.com/f[1]']);
    // IPv6 host balanced; free outer ] cuts after path.
    expect(extractHttpLinks('[http://[::1]:8080/v]')).toEqual(['http://[::1]:8080/v']);
    // No prose `[` opener: free `]` mid-path stays (not a wrapper cut).
    expect(
      [...bareUrlSpans('https://a.com/x[1]')].map((s) => s.clean),
    ).toEqual(['https://a.com/x[1]']);
  });
});

describe('extractOtp (combined)', () => {
  test('realistic HTML verification mail with both code and link', () => {
    const html = `<html><body>
      <p>Hi there,</p>
      <p>Your verification code is <strong>604218</strong>.</p>
      <p>Or <a href="https://app.example.com/verify-email?token=zzz">click here to verify</a>.</p>
      <style>.footer{font-size:9px}</style>
    </body></html>`;
    const otp = extractOtp('', html);
    expect(otp.codes).toEqual(['604218']);
    expect(otp.links).toEqual(['https://app.example.com/verify-email?token=zzz']);
  });

  test('plain-text password reset mail', () => {
    const text = 'Reset your password: https://example.com/reset-password?token=tok123\nThis link expires soon.';
    const otp = extractOtp(text);
    expect(otp.codes).toEqual([]);
    expect(otp.links).toEqual(['https://example.com/reset-password?token=tok123']);
  });

  test('newsletter yields nothing', () => {
    const otp = extractOtp('This week in tech: 2024 trends. Read more at https://blog.example.com/posts/42');
    expect(otp).toEqual({ codes: [], links: [] });
  });
});

describe('extractHttpLinks', () => {
  test('collects ordinary body links independently of OTP intent', () => {
    const html =
      '<a href="https://example.com/docs?a=1&amp;b=2">Docs</a>' +
      '<a href="javascript:alert(1)">bad</a>';
    expect(extractHttpLinks('News: http://news.example/path', html)).toEqual([
      'https://example.com/docs?a=1&b=2',
      'http://news.example/path',
    ]);
  });

  test('rejects malformed and non-http schemes after URL parsing', () => {
    expect(
      extractHttpLinks(
        'mailto:user@example.com javascript:alert(1) https://valid.example/x',
        '<a href="data:text/html,bad">bad</a>',
      ),
    ).toEqual(['https://valid.example/x']);
  });
});

/**
 * Fixtures modelled on the real mails agents actually receive when signing
 * up for services. Formats sampled from live mail (codes anonymized).
 */
describe('provider fixtures — codes', () => {
  test('Google: "G-123456 is your Google verification code"', () => {
    expect(extractCodes('G-482916 is your Google verification code.')).toEqual(['482916']);
  });

  test('GitHub launch code (8 digits)', () => {
    const text = 'Here’s your GitHub launch code, @agent!\n\n59162834\n\nOpen GitHub';
    expect(extractCodes(text)).toEqual(['59162834']);
  });

  test('Amazon OTP', () => {
    const text = 'Your One Time Password (OTP) is: 774201\nDo not share this OTP with anyone.';
    expect(extractCodes(text)).toEqual(['774201']);
  });

  test('Microsoft account security code', () => {
    const text = 'Microsoft account\n\nYour security code is: 5519283\n\nIf you didn’t request this, ignore.';
    expect(extractCodes(text)).toEqual(['5519283']);
  });

  test('OpenAI / ChatGPT code', () => {
    expect(extractCodes('Your ChatGPT code is 662130')).toEqual(['662130']);
  });

  test('Discord security code', () => {
    expect(extractCodes('Your Discord security code is: 318844')).toEqual(['318844']);
  });

  test('阿里云', () => {
    const text = '【阿里云】您正在注册阿里云账号，验证码：509227，请在15分钟内完成验证。';
    expect(extractCodes(text)).toEqual(['509227']);
  });

  test('腾讯云（验证码与数字之间无空格）', () => {
    const text = '【腾讯云】您的验证码为746103，该验证码5分钟内有效，请勿泄露于他人。';
    expect(extractCodes(text)).toEqual(['746103']);
  });

  test('网易邮箱大师', () => {
    const text = '【网易】验证码：2281，您正在登录邮箱，请勿将验证码告诉他人。';
    expect(extractCodes(text)).toEqual(['2281']);
  });

  test('code first, keyword after (digit-led format)', () => {
    expect(extractCodes('830214 is your verification code. It expires in 10 minutes.')).toEqual(['830214']);
  });

  test('HTML part with the code split across tags', () => {
    const html = `<body><p>Your Google verification code</p>
      <h2>G- <span>77</span><span>4102</span></h2></body>`;
    const otp = extractOtp('', html);
    expect(otp.codes).toEqual(['774102']);
  });
});

describe('provider fixtures — links', () => {
  test('GitHub verify-email button', () => {
    const html = `<body><p>Welcome to GitHub!</p>
      <a href="https://github.com/users/agent/emails/confirm_verification/abc123?via_launch_code_email=true">Verify email address</a></body>`;
    const links = extractLinks(htmlToText(html), html);
    expect(links).toEqual([
      'https://github.com/users/agent/emails/confirm_verification/abc123?via_launch_code_email=true',
    ]);
  });

  test('Slack magic sign-in link', () => {
    const text = 'Sign in to Slack: https://slack.com/signin/magic/xyz-123 — expires in 30 minutes.';
    expect(extractLinks(text)).toEqual(['https://slack.com/signin/magic/xyz-123']);
  });

  test('magic link with neutral URL but action anchor text', () => {
    const html = '<p><a href="https://app.example.com/e/clkn?d=xyz">Confirm your account</a></p>';
    const links = extractLinks(htmlToText(html), html);
    expect(links).toEqual(['https://app.example.com/e/clkn?d=xyz']);
  });
});
