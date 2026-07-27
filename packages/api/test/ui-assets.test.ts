import { describe, expect, test } from 'bun:test';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { createApp } = await import('../src/app.ts');
const { OUTER_CSP, UI_CSS, UI_HTML, UI_JS } = await import('../src/ui/assets.ts');

describe('UI static asset contract', () => {
  const app = createApp({ uiEnabled: true });

  test('/ui and /ui/ serve the same shell with absolute assets', async () => {
    const bare = await app.request('/ui');
    const slash = await app.request('/ui/');
    expect(bare.status).toBe(200);
    expect(slash.status).toBe(200);
    expect(await bare.text()).toBe(await slash.text());
    expect(UI_HTML).toContain('href="/ui/styles.css"');
    expect(UI_HTML).toContain('src="/ui/app.js"');
    expect(UI_HTML).toContain('<link rel="icon" href="/ui/favicon.ico">');
    expect(OUTER_CSP).toContain("img-src 'self'");
    expect((await app.request('/ui/favicon.ico')).status).toBe(204);
  });

  test('shell and assets have strict types and an outer CSP', async () => {
    const shell = await app.request('/ui');
    expect(shell.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(shell.headers.get('content-security-policy')).toBe(OUTER_CSP);
    expect(shell.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(shell.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(shell.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    expect(OUTER_CSP).toContain("default-src 'none'");
    expect(OUTER_CSP).toContain("frame-src 'self'");
    expect(OUTER_CSP).not.toContain("'unsafe-inline'");

    const script = await app.request('/ui/app.js');
    const styles = await app.request('/ui/styles.css');
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(styles.headers.get('content-type')).toContain('text/css');
    expect(await script.text()).toBe(UI_JS);
    expect(await styles.text()).toBe(UI_CSS);
  });

  test('shell has no inline execution hooks', () => {
    expect(UI_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(UI_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(UI_HTML).not.toMatch(/\sstyle\s*=/i);
  });

  test('front-end code contains no HTML parser sinks or URL-token reader', () => {
    expect(UI_JS).not.toMatch(
      /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\s*\(|new\s+Function\b/,
    );
    expect(UI_JS).not.toMatch(/URLSearchParams|location\.search|searchParams/);
    expect(UI_JS).toContain('history.replaceState');
    expect(UI_JS).toContain('window.isSecureContext');
  });

  test('a first visit is not mislabeled as an expired session', () => {
    expect(UI_JS).toContain("if (response.status === 401) { showLogin(''); return; }");
  });

  test('link and frame creation retain both execution-point defenses', () => {
    expect(UI_JS).toContain("new URL(");
    expect(UI_JS).toContain("protocol !== 'http:'");
    expect(UI_JS).toContain("setAttribute('sandbox', '')");
    expect(UI_JS).toContain('/ui/frame/');
    expect(UI_JS).not.toContain('allow-same-origin');
    expect(UI_JS).not.toContain('allow-scripts');
  });

  test('oversized HTML disables its tab and explains the plain-text fallback', () => {
    expect(UI_JS).toContain('detail.htmlTooLarge');
    expect(UI_JS).toContain('too large to preview');
  });

  test('detail requests cannot cross an identity switch or overwrite newer state', () => {
    expect(UI_JS).toContain('var requestedDetailAddress = state.activeAddress;');
    expect(UI_JS).toContain('state.activeAddress !== requestedDetailAddress');

    const selectIdentity = UI_JS.slice(
      UI_JS.indexOf('async function selectIdentity'),
      UI_JS.indexOf('async function refreshMessages'),
    );
    expect(selectIdentity.indexOf('detailController.abort()')).toBeGreaterThan(-1);
    expect(selectIdentity.indexOf('detailController.abort()')).toBeLessThan(
      selectIdentity.indexOf('await waitForPreviousRefresh()'),
    );
  });

  test('clipboard fallback selects the visible source for manual copying', () => {
    expect(UI_JS).toContain('function selectForManualCopy(sourceNode)');
    expect(UI_JS).toContain('range.selectNodeContents(sourceNode)');
    expect(UI_JS).toContain('selection.addRange(range)');
    expect(UI_JS).toContain('return selection.toString() === sourceNode.textContent');
  });

  test('unknown UI paths are 404 and UI_ENABLED=false removes the whole surface', async () => {
    expect((await app.request('/ui/unknown')).status).toBe(404);

    const disabled = createApp({ uiEnabled: false });
    for (const path of [
      '/ui',
      '/ui/',
      '/ui/app.js',
      '/ui/api/me',
      '/ui/frame/1?address=fox%40test.example',
    ]) {
      expect((await disabled.request(path)).status).toBe(404);
    }
  });
});
