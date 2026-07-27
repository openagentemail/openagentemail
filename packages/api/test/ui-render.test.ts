import { describe, expect, test } from 'bun:test';
import {
  MAX_EMAIL_HTML_LENGTH,
  sanitizeEmailHtml,
} from '../src/lib/sanitize-email-html.ts';

const poison = [
  '<script>globalThis.pwned=1</script><p>safe</p>',
  '<STYLE>body{background:url(https://evil.example/x)}</STYLE><p>safe</p>',
  '<textarea><img src=x onerror=alert(1)></textarea><p>safe</p>',
  '<noscript><img src=x onerror=alert(1)></noscript><p>safe</p>',
  '<iframe srcdoc="<script>alert(1)</script>">hidden</iframe><p>safe</p>',
  '<svg onload=alert(1)><a href="javascript:alert(2)">x</a></svg><p>safe</p>',
  '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math><p>safe</p>',
  '<img src="https://evil.example/pixel" onerror=alert(1)><p>safe</p>',
  '<a href="javascript:alert(1)" ping="https://evil.example">click</a>',
  '<form action="https://evil.example"><input autofocus onfocus=alert(1)>form text</form>',
  '<ScRiPt\nsrc="https://evil.example/x.js">bad</sCrIpT><p>safe</p>',
  '<a href="jav&#x61;script:alert(1)">entity link</a>',
  '<p ONCLICK=alert(1) onpointerenter=alert(2)>safe</p>',
  '<div style="background:url(https://evil.example/x)">safe</div>',
  '<base href="https://evil.example/"><meta http-equiv=refresh content="0;url=https://evil.example">',
  '<object data="https://evil.example/x"><embed src="https://evil.example/y">hidden</object><p>safe</p>',
  '<template><img src=x onerror=alert(1)></template><p>safe</p>',
  '<!--[if IE]><script>alert(1)</script><![endif]--><p>safe</p>',
  '<svg><style><img src=x onerror=alert(1)></style></svg><p>safe</p>',
  '<p><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
];

describe('email HTML sanitizer', () => {
  test.each(poison)('neutralizes poison corpus %#', (input) => {
    const result = sanitizeEmailHtml(input);
    expect(result.kind).toBe('ok');
    expect(result.html).not.toMatch(
      /script|style=|onerror|onclick|onfocus|onload|javascript:|https:\/\/evil\.example|src=|href=|<iframe|<svg|<math|<form|<input|<object|<embed|<template/i,
    );
  });

  test('locks the exact tag and numeric table-span policy', () => {
    const input =
      '<DIV class=x><P id=y>Hello <STRONG onclick=x>world</STRONG></P>' +
      '<table><thead><tr><th colspan="2" rowspan="-1" title=x>Head</th></tr></thead>' +
      '<tbody><tr><td rowspan="03" colspan="1.5" style=x>Cell</td></tr></tbody></table>' +
      '<table><tr><td colspan="999" rowspan="1000">Bounded</td>' +
      '<td colspan="0" rowspan="1">Positive</td></tr></table>' +
      '<section data-x=x>kept text</section></DIV>';
    expect(sanitizeEmailHtml(input)).toEqual({
      kind: 'ok',
      html:
        '<div><p>Hello <strong>world</strong></p>' +
        '<table><thead><tr><th colspan="2">Head</th></tr></thead>' +
        '<tbody><tr><td>Cell</td></tr></tbody></table>' +
        '<table><tr><td colspan="999">Bounded</td>' +
        '<td rowspan="1">Positive</td></tr></table>' +
        'kept text</div>',
    });
  });

  test('is idempotent across the poison corpus', () => {
    for (const input of poison) {
      const once = sanitizeEmailHtml(input);
      expect(once.kind).toBe('ok');
      if (once.kind !== 'ok') continue;
      expect(sanitizeEmailHtml(once.html)).toEqual(once);
    }
  });

  test('rejects over 512 KiB before invoking the library', () => {
    let called = false;
    const result = sanitizeEmailHtml('x'.repeat(MAX_EMAIL_HTML_LENGTH + 1), () => {
      called = true;
      return 'should not run';
    });
    expect(result).toEqual({ kind: 'too_large', html: '' });
    expect(called).toBe(false);
  });

  test('sanitizer exceptions fail closed to an empty body', () => {
    const result = sanitizeEmailHtml('<p>secret</p>', () => {
      throw new Error('parser failed with <p>secret</p>');
    });
    expect(result).toEqual({ kind: 'failed', html: '' });
    expect(result.html).not.toContain('secret');
  });

  test('non-string and hostile runtime inputs fail closed without throwing', () => {
    for (const input of [undefined, null, 42, { length: 1 }]) {
      expect(sanitizeEmailHtml(input as unknown as string)).toEqual({
        kind: 'failed',
        html: '',
      });
    }
    const hostile = Object.defineProperty({}, 'length', {
      get() {
        throw new Error('hostile length getter');
      },
    });
    expect(sanitizeEmailHtml(hostile as unknown as string)).toEqual({
      kind: 'failed',
      html: '',
    });
  });
});
