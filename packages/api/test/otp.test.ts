import { describe, expect, test } from 'bun:test';
import { extractCodes, extractLinks, extractOtp, htmlToText } from '../src/lib/otp.ts';

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

  test('returns empty for unrelated links only', () => {
    expect(extractLinks('Docs at https://example.com/docs and https://example.com/about')).toEqual([]);
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
