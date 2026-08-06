import { describe, expect, test } from 'bun:test';
import {
  BARE_URL_RE,
  extractCodes,
  extractHttpLinks,
  extractLinks,
  extractOtp,
  htmlToText,
  splitBareUrlCandidate,
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

  test('ignores years without an explicit code keyword', () => {
    expect(extractCodes('Our verification team, since 2024, sends regards.')).toEqual([]);
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

  test('BARE_URL_RE and splitBareUrlCandidate stay linear on adversarial inputs', () => {
    const freeBrackets = `https://${'['.repeat(10_000)}`;
    const nestedParens = `https://x.com/${'('.repeat(5_000)}${')'.repeat(5_000)}`;
    const started = performance.now();
    freeBrackets.match(BARE_URL_RE);
    nestedParens.match(BARE_URL_RE);
    splitBareUrlCandidate(freeBrackets);
    splitBareUrlCandidate(nestedParens);
    expect(performance.now() - started).toBeLessThan(1_000);
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
