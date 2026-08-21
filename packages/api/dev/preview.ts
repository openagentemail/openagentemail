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
const { registerUiAssets, registerUiShell } = await import('../src/routes/ui-assets.ts');
const { createUiFrameRoutes } = await import('../src/routes/ui-frame.ts');

// PREVIEW_OVERVIEW=ready|stale|loading|unavailable|empty 切换 Overview 的五种状态；
// PREVIEW_IDENTITIES=200 切到大身份量 fixture（验收 200 行渲染）。
const overviewMode = process.env.PREVIEW_OVERVIEW ?? 'ready';
const identityTotal = Math.max(0, Number(process.env.PREVIEW_IDENTITIES ?? 2));

const baseIdentities = [
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

/** 确定性身份列表：前两个固定，其余按序号生成，便于筛选/排序验收。 */
function buildIdentities() {
  if (overviewMode === 'empty') return [];
  const all = baseIdentities.slice(0, Math.min(identityTotal, baseIdentities.length));
  for (let index = all.length; index < identityTotal; index += 1) {
    const label = index % 3 === 0 ? 'Billing bot' : index % 3 === 1 ? 'Signup agent' : 'Cold outreach';
    all.push({
      address: `agent-${String(index).padStart(3, '0')}@preview.test`,
      name: `${label} ${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 1 + (index % 26), 8, index % 60)).toISOString(),
    });
  }
  return all;
}

const identities = buildIdentities();

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

/** 确定性快照：每个身份的命中数只由它在列表里的序号决定。 */
function buildSnapshot(scannedAt: number) {
  const records: Array<{ t: number; s: boolean; r: string[] }> = [];
  identities.forEach((identity, index) => {
    if (identity.address === 'empty@preview.test') return;
    const hits = 1 + ((index * 7) % 9);
    for (let hit = 0; hit < hits; hit += 1) {
      records.push({
        t: scannedAt - (index * 90_000 + hit * 60_000),
        s: (index + hit) % 3 !== 0,
        r: [identity.address],
      });
    }
  });
  // 一封同时投给前两个身份的信（验收"计数重叠"的副文案）
  if (identities.length > 1) {
    records.push({
      t: scannedAt - 30_000,
      s: false,
      r: [identities[0].address, identities[1].address],
    });
  }
  // 20 封与任何身份都不匹配的外部邮件 → unmatchedInWindow 有非零值
  for (let extra = 0; extra < 20; extra += 1) {
    records.push({ t: scannedAt - 600_000 - extra * 1000, s: true, r: [] });
  }
  return {
    records,
    scanned: records.length,
    mailboxTotal: records.length + 740,
    truncated: true,
    partial: false,
    incompleteFor: new Set<string>(),
    identityAddressesAtScan: identities.map((identity) => identity.address),
    scannedAt,
  };
}

/** 五模式的确定性 fake：路由只认这一个函数，缓存与 IMAP 细节都在它后面。 */
async function getMailboxScan(_opts: { refresh: boolean; identityAddresses: string[] }) {
  const now = Date.now();
  if (overviewMode === 'loading') return { kind: 'loading' as const, now, retryAfterMs: 1000 };
  if (overviewMode === 'unavailable') {
    return {
      kind: 'unavailable' as const,
      now,
      reason: 'imap_unavailable' as const,
      retryAfterSeconds: 5,
    };
  }
  if (overviewMode === 'empty') {
    return {
      kind: 'ready' as const,
      now,
      snapshot: null,
      cached: false,
      revalidating: false,
      refreshError: false,
    };
  }
  if (overviewMode === 'stale') {
    return {
      kind: 'stale' as const,
      now,
      snapshot: buildSnapshot(now - 120_000),
      cached: true,
      revalidating: false,
      refreshError: true,
      retryAfterMs: 5000,
    };
  }
  return {
    kind: 'ready' as const,
    now,
    snapshot: buildSnapshot(now - 2000),
    cached: false,
    revalidating: false,
    refreshError: false,
  };
}

type PreviewNotifyMessage = {
  id: string;
  time: number;
  title: string;
  message: string;
  priority: number;
  tags: string[];
};

/** 把 ntfy since（如 12h / 10m / unix 秒）折成 unix 截止秒；无法解析则不过滤。 */
function previewSinceCutoff(since?: string): number | null {
  if (!since) return null;
  const relative = /^(\d+)([smhd])$/i.exec(since.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms =
      unit === 's'
        ? amount * 1000
        : unit === 'm'
          ? amount * 60_000
          : unit === 'h'
            ? amount * 3_600_000
            : amount * 86_400_000;
    return Math.floor((Date.now() - ms) / 1000);
  }
  const asUnix = Number(since);
  if (Number.isFinite(asUnix) && asUnix > 0) return Math.floor(asUnix);
  return null;
}

/**
 * 通知记录假数据：覆盖 urgent/normal/low/unknown 四档 + user / agent 两路 topic。
 * 时间相对 Date.now()；附带一条 >12h 的旧消息，供 since=12h 过滤验收。
 */
function buildPreviewNotifyMessages(topic: string, since?: string): PreviewNotifyMessage[] {
  const now = Math.floor(Date.now() / 1000);
  const catalog: Record<string, PreviewNotifyMessage[]> = {
    'user-alerts': [
      {
        id: 'preview-n1',
        time: now - 60,
        title: 'Urgent: mailbox full',
        message: 'fox@preview.test is near the retention ceiling.',
        priority: 5,
        tags: ['warning'],
      },
      {
        id: 'preview-n2',
        time: now - 300,
        title: 'Normal: new signup',
        message: 'An agent requested can_notify_user.',
        priority: 3,
        tags: [],
      },
      {
        id: 'preview-n-old-alerts',
        time: now - 48 * 3600,
        title: 'Stale alert outside 12h',
        message: 'Should be filtered out when since=12h.',
        priority: 3,
        tags: [],
      },
    ],
    'user-low': [
      {
        id: 'preview-n3',
        time: now - 600,
        title: 'Low: weekly digest',
        message: '12 pushes delivered in the last 7 days.',
        priority: 1,
        tags: ['memo'],
      },
      {
        id: 'preview-n4',
        time: now - 900,
        title: 'Odd priority sample',
        message: 'priority=2 should render as unknown tier in the panel.',
        priority: 2,
        tags: [],
      },
    ],
    'agent:fox': [
      {
        id: 'preview-n5',
        time: now - 120,
        title: 'openagent.email new mail',
        message: 'fox@preview.test received new email',
        priority: 3,
        tags: ['email'],
      },
    ],
  };
  const list = catalog[topic] ?? [];
  const cutoff = previewSinceCutoff(since);
  if (cutoff == null) return list;
  return list.filter((entry) => entry.time >= cutoff);
}

const dependencies = {
  listIdentities: () => identities,
  listMessages: async (address: string, limit: number, query?: { folder?: string }) => {
    const folder = query?.folder ?? 'inbox';
    if (address !== 'fox@preview.test') return { messages: [], nextCursor: null };
    if (folder === 'sent') return { messages: [], nextCursor: null };
    return { messages: messages.slice(0, limit), nextCursor: null };
  },
  getMessage: async (address: string, id: string) =>
    address === 'fox@preview.test' ? (details.get(id) ?? null) : null,
  getMessageSource: async (address: string, id: string) => {
    if (address !== 'fox@preview.test' || !details.has(id)) return null;
    const detail = details.get(id)!;
    const source =
      `From: ${detail.from}\r\nTo: ${detail.to}\r\nSubject: ${detail.subject}\r\n\r\n` +
      (detail.text ?? '');
    return { id, source, truncated: false, byteLength: Buffer.byteLength(source) };
  },
  getMailboxScan,
  setPushContentTier: (address: string, tier: 1 | 2 | 3) => {
    const identity = identities.find((entry) => entry.address === address.toLowerCase());
    if (!identity) return null;
    (identity as { pushContentTier?: 1 | 2 | 3 }).pushContentTier = tier;
    return identity as typeof identity & { pushContentTier: 1 | 2 | 3 };
  },
  // 确定性假数据：预览不连 ntfy；相对时间 + since 过滤，面板演示不会像「坏了」。
  notifyMessages: async (topic: string, _identityAddress?: string, since?: string) =>
    buildPreviewNotifyMessages(topic, since),
};

const app = new Hono();
const sessions = new UiSessionStore({
  // 第二个 token 是 identity 会话，供验收断言"identity 永远看不到 Overview"。
  resolveToken: (token) => {
    if (token === 'preview-token') return { kind: 'admin' };
    if (token === 'preview-identity-token') {
      return { kind: 'identity', address: 'fox@preview.test' };
    }
    return null;
  },
});
registerUiAssets(app);
app.use('/ui/api/session', uiSessionBodyLimit);
app.use('/ui/api/session', requireUiOrigin);
app.route('/ui/api/session', createUiSessionRoutes(sessions));
app.route('/ui/api', createUiApiRoutes(sessions, dependencies));
app.route('/ui/frame', createUiFrameRoutes(sessions, dependencies));
registerUiShell(app);

const port = Number(process.env.PREVIEW_PORT ?? 4310);
Bun.serve({ port, fetch: app.fetch });
console.log(
  `[ui-preview] http://localhost:${port}/ui — admin token: preview-token · identity token: preview-identity-token`,
);
console.log(
  `[ui-preview] PREVIEW_OVERVIEW=${overviewMode} PREVIEW_IDENTITIES=${identities.length}`,
);
