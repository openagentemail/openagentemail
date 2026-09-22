/**
 * #319 受控实测探针：真打本机开发态 API（server.fetch），勿打生产。
 * 脚本路径：materials/319/probe-attachments.ts
 * 运行：cd packages/api && bun ../../materials/319/probe-attachments.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mock } from 'bun:test';

const OUT_DIR = dirname(new URL(import.meta.url).pathname);
const STARTED_AT = new Date().toISOString();

// —— 开发态环境（隔离 DATA_DIR，不碰生产）——
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-319';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret-319';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret-319';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-319-probe-'));
process.env.UI_ENABLED = 'false';
process.env.WEBHOOKS_ENABLED = 'true';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.SEND_RATE_LIMIT = '100';

// SMTP 打桩：让无附件基线能落到「queued」而非 smtp_error
mock.module('../../packages/api/src/lib/smtp.ts', () => ({
  sendMail: async () => ({ messageId: '<probe-319@test.example>' }),
}));

const { createApp } = await import('../../packages/api/src/app.ts');
const { createIdentity } = await import('../../packages/api/src/lib/identities.ts');
const { config } = await import('../../packages/api/src/lib/config.ts');
const { createWebhookSink } = await import('../../packages/api/src/lib/webhook-sink.ts');
const {
  deliveryQueue,
  readAllDeliveryLogRows,
  formatMailPayload,
} = await import('../../packages/api/src/lib/webhook-delivery.ts');
const {
  createWebhookSubscription,
  resetWebhooksStoreForTests,
  setWebhooksFailClosedForTests,
} = await import('../../packages/api/src/lib/webhook-store.ts');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: false });
const MCP_ACCEPT = 'application/json, text/event-stream';

type ProbeResult = {
  id: string;
  title: string;
  expectedNote: string;
  requestSummary: Record<string, unknown>;
  status: number | null;
  bodyText: string;
  notes: string[];
};

const results: ProbeResult[] = [];
const logLines: string[] = [];

function log(line: string) {
  console.log(line);
  logLines.push(line);
}

function section(title: string) {
  log('');
  log(`===== ${title} =====`);
}

async function postSend(body: unknown): Promise<{ status: number; text: string }> {
  const res = await app.request('/v1/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function postSendRaw(rawBody: string): Promise<{ status: number; text: string }> {
  const res = await app.request('/v1/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
    },
    body: rawBody,
  });
  return { status: res.status, text: await res.text() };
}

async function readMcpJson(res: Response): Promise<unknown> {
  const text = await res.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (dataLine) return JSON.parse(dataLine.slice('data: '.length));
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function record(r: ProbeResult) {
  results.push(r);
  log(`[${r.id}] ${r.title}`);
  log(`  expected_note: ${r.expectedNote}`);
  log(`  status: ${r.status}`);
  log(`  body: ${r.bodyText}`);
  for (const n of r.notes) log(`  note: ${n}`);
}

// —— 准备身份（返回 { identity, token }）——
const created = createIdentity({ localpart: 'probe319' });
if (!created) throw new Error('createIdentity failed');
const from = created.identity.address;
log(`#319 probe start ${STARTED_AT}`);
log(`DATA_DIR=${process.env.DATA_DIR}`);
log(`from=${from}`);
log(`endpoint_note=任务卡写 POST /v1/messages；本仓发信 schema 落点为 POST /v1/send（messages 无 POST 发信）`);

// ========== 组1：Base64 attachments[] ==========
section('G1 POST /v1/send + attachments Base64');
{
  const body = {
    from,
    to: 'recipient@example.net',
    subject: '319-g1-b64',
    text: 'hello-g1',
    attachments: [
      {
        content: Buffer.from('report-body').toString('base64'),
        filename: 'Q4-report.txt',
        content_type: 'text/plain',
      },
    ],
  };
  const { status, text } = await postSend(body);
  record({
    id: 'G1',
    title: 'POST /v1/send 携 attachments[]（Base64 content）',
    expectedNote: '任务卡预期 400（假定 .strict()）；R0 同口径。实测以本机响应为准。',
    requestSummary: { path: '/v1/send', hasAttachmentsKey: true, form: 'base64-content' },
    status,
    bodyText: text,
    notes: [
      'sendSchema@packages/api/src/routes/send.ts:41-47 无 .strict()',
      'Zod 默认剥未知键；若 status≠400 则证明 attachments 被静默剥离而非拒收',
    ],
  });
}

// ========== 组2：URL attachments[] ==========
section('G2 POST /v1/send + attachments URL');
{
  const body = {
    from,
    to: 'recipient@example.net',
    subject: '319-g2-url',
    text: 'hello-g2',
    attachments: [
      {
        url: 'https://example.com/files/invoice.pdf',
        filename: 'invoice.pdf',
        content_type: 'application/pdf',
      },
    ],
  };
  const { status, text } = await postSend(body);
  record({
    id: 'G2',
    title: 'POST /v1/send 携 attachments[]（URL 形态）',
    expectedNote: '任务卡预期 400；实测以本机响应为准。',
    requestSummary: { path: '/v1/send', hasAttachmentsKey: true, form: 'url' },
    status,
    bodyText: text,
    notes: ['同 G1：无 .strict() 时未知键剥离'],
  });
}

// ========== 组3：无附件基线 ==========
section('G3 无附件基线发送');
{
  const body = {
    from,
    to: 'recipient@example.net',
    subject: '319-g3-baseline',
    text: 'hello-g3-baseline',
  };
  const { status, text } = await postSend(body);
  record({
    id: 'G3',
    title: '无附件基线 POST /v1/send',
    expectedNote: '任务卡写 201；本仓成功码为 200 {queued:true}（见 send.ts 返回）。',
    requestSummary: { path: '/v1/send', hasAttachmentsKey: false },
    status,
    bodyText: text,
    notes: ['SMTP 已 mock；用于证明路由本身可成功，避免「全 400」误读'],
  });
}

// ========== 组4：尺寸探针 ==========
section('G4 尺寸探针 text/html 1e6 + 16MiB body');
{
  // 4a: text 恰 1_000_000 → 应过 schema
  const textOk = 't'.repeat(1_000_000);
  const r4a = await postSend({
    from,
    to: 'recipient@example.net',
    subject: '319-g4a-text-1e6',
    text: textOk,
  });
  record({
    id: 'G4a',
    title: 'text 长度 = 1_000_000（schema 上限）',
    expectedNote: '应非 400（schema 接受）；SMTP mock 下期望 200',
    requestSummary: { textChars: 1_000_000 },
    status: r4a.status,
    bodyText: r4a.text.slice(0, 500),
    notes: ['锚点 sendSchema text max 1_000_000 @ send.ts:45'],
  });

  // 4b: text 1_000_001 → 400
  const textOver = 't'.repeat(1_000_001);
  const r4b = await postSend({
    from,
    to: 'recipient@example.net',
    subject: '319-g4b-text-1e6+1',
    text: textOver,
  });
  record({
    id: 'G4b',
    title: 'text 长度 = 1_000_001（超 schema）',
    expectedNote: '400 invalid_request',
    requestSummary: { textChars: 1_000_001 },
    status: r4b.status,
    bodyText: r4b.text.slice(0, 800),
    notes: [],
  });

  // 4c: html 恰 1_000_000
  const htmlOk = 'h'.repeat(1_000_000);
  const r4c = await postSend({
    from,
    to: 'recipient@example.net',
    subject: '319-g4c-html-1e6',
    text: 'x',
    html: htmlOk,
  });
  record({
    id: 'G4c',
    title: 'html 长度 = 1_000_000（schema 上限）',
    expectedNote: '应非 400；期望 200',
    requestSummary: { htmlChars: 1_000_000 },
    status: r4c.status,
    bodyText: r4c.text.slice(0, 500),
    notes: ['锚点 sendSchema html max 1_000_000 @ send.ts:46'],
  });

  // 4d: html 1_000_001
  const htmlOver = 'h'.repeat(1_000_001);
  const r4d = await postSend({
    from,
    to: 'recipient@example.net',
    subject: '319-g4d-html-1e6+1',
    text: 'x',
    html: htmlOver,
  });
  record({
    id: 'G4d',
    title: 'html 长度 = 1_000_001（超 schema）',
    expectedNote: '400 invalid_request',
    requestSummary: { htmlChars: 1_000_001 },
    status: r4d.status,
    bodyText: r4d.text.slice(0, 800),
    notes: [],
  });

  // 4e: 请求体逼近并超过 16 MiB → 413
  // 构造约 17 MiB 的 JSON（与 request-size.test.ts 同法）
  const hugeText = 'x'.repeat(17 * 1024 * 1024);
  const hugeBody = JSON.stringify({
    from,
    to: 'recipient@example.net',
    subject: '319-g4e-17mib',
    text: hugeText,
  });
  log(`  G4e rawBodyBytes=${Buffer.byteLength(hugeBody, 'utf8')}`);
  const r4e = await postSendRaw(hugeBody);
  record({
    id: 'G4e',
    title: '请求体 ≈17 MiB（超 JSON_BODY_LIMIT_BYTES=16MiB）',
    expectedNote: '413 request_too_large（解析前拒）',
    requestSummary: {
      rawBodyBytes: Buffer.byteLength(hugeBody, 'utf8'),
      limit: 'JSON_BODY_LIMIT_BYTES=16*1024*1024',
    },
    status: r4e.status,
    bodyText: r4e.text.slice(0, 500),
    notes: ['锚点 packages/api/src/lib/limits.ts:5；app.ts bodyLimit'],
  });

  // 4f: 略小于 16 MiB 的请求体（无超大 text 字段，验证 limit 本身）
  // 使用重复字段撑大体但不触发 zod text max——直接塞超大未知键会被剥；
  // 这里用刚好小于 16MiB 的合法 text（受 1e6 限制），所以「体 <16MiB 且字段合法」已由 G4a 覆盖。
  // 另测：构造无 zod 字段超限、但 body 仍 <16MiB 的垫片——用 subject 重复不够。
  // 记录：无独立「附件尺寸常量」；仅有 text/html 1e6 与整请求 16MiB。
}

// ========== 组5：webhook 含附件入站 ==========
section('G5 webhook sink：含附件 MIME → payload 仅 hasAttachments');
{
  const webhookDataDir = join(process.env.DATA_DIR!, 'webhook-319');
  mkdirSync(webhookDataDir, { recursive: true, mode: 0o700 });
  (config as { dataDir: string }).dataDir = process.env.DATA_DIR!;
  (config.webhooks as { enabled: boolean }).enabled = true;
  (config.webhooks as { signingSecret: string }).signingSecret =
    '01234567890123456789012345678901';
  resetWebhooksStoreForTests();
  setWebhooksFailClosedForTests(false);
  deliveryQueue.cancelAll();

  const sub = createWebhookSubscription({
    url: 'https://127.0.0.1:9/hook-319-sink', // 故意不可达；本探针只断言入队 payload 形态
    events: ['mail.received'],
    contentScope: 'preview',
    address: from,
  });

  const boundary = '----=_319_PROBE_BOUNDARY';
  const attContent = 'INVOICE-BYTES-319';
  const rawMime =
    `From: Sender <sender@external.example>\r\n` +
    `To: ${from}\r\n` +
    `Subject: Invoice with attachment\r\n` +
    `Message-ID: <att-319@external.example>\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    `Please see attached invoice.\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/pdf; name="invoice.pdf"\r\n` +
    `Content-Disposition: attachment; filename="invoice.pdf"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    `${Buffer.from(attContent).toString('base64')}\r\n` +
    `--${boundary}--\r\n`;

  const sink = createWebhookSink();
  await sink.handleMail!({
    type: 'mail.received',
    message: {
      uid: 31901,
      internalDate: new Date('2026-09-22T10:00:00.000Z'),
      flags: new Set(),
      envelope: {
        from: [{ name: 'Sender', address: 'sender@external.example' }],
        to: [{ address: from }],
        subject: 'Invoice with attachment',
        messageId: '<att-319@external.example>',
      },
      source: Buffer.from(rawMime, 'utf8'),
    },
    uidValidity: 99n,
  });

  const rows = readAllDeliveryLogRows();
  const row = rows.find((r) => r.messageId === '31901') ?? rows[rows.length - 1];

  // 用 formatMailPayload 复现将投递的 body（与 enqueue 时同 builder）
  const envelope = {
    id: 'evt_probe_319',
    type: 'mail.received' as const,
    payloadVersion: 'v1' as const,
    createdAt: new Date().toISOString(),
    domain: config.domain,
  };
  // 直接从 sink 路径无法读回 input；再跑一次 simpleParser 对齐断言，并用 formatMailPayload
  const { simpleParser } = await import('mailparser');
  const parsed = await simpleParser(Buffer.from(rawMime, 'utf8'));
  const hasAttachments = (parsed.attachments?.length ?? 0) > 0;
  const formatted = formatMailPayload(sub, envelope, {
    address: from,
    messageId: '31901',
    uid: 31901,
    uidValidity: 99,
    receivedAt: '2026-09-22T10:00:00.000Z',
    from: { address: 'sender@external.example', name: 'Sender' },
    to: [from],
    cc: [],
    subject: 'Invoice with attachment',
    sizeBytes: Buffer.byteLength(rawMime, 'utf8'),
    hasAttachments,
    unread: true,
    containsSecurityCode: false,
    containsLink: false,
    textPreview: (parsed.text ?? '').trim(),
    securityCodes: [],
    links: [],
  });

  const payloadObj = JSON.parse(formatted.body) as {
    data?: Record<string, unknown>;
  };
  const dataKeys = Object.keys(payloadObj.data ?? {});
  const forbiddenContentKeys = [
    'attachments',
    'attachment',
    'attachmentContent',
    'attachmentBytes',
    'files',
    'content',
    'contentBase64',
  ];
  const leaked = forbiddenContentKeys.filter((k) => k in (payloadObj.data ?? {}));

  log(`  delivery_rows=${rows.length} last_messageId=${row?.messageId} hasAttachments_parsed=${hasAttachments}`);
  log(`  payload_body=${formatted.body}`);
  log(`  data_keys=${JSON.stringify(dataKeys)}`);
  log(`  leaked_content_keys=${JSON.stringify(leaked)}`);

  record({
    id: 'G5',
    title: 'webhook：含附件入站 → payload 仅 hasAttachments 元数据',
    expectedNote: 'hasAttachments:true；无附件内容字段',
    requestSummary: {
      sink: 'createWebhookSink().handleMail',
      mime: 'multipart/mixed + attachment disposition',
      contentScope: 'preview',
    },
    status: row ? 0 : -1,
    bodyText: formatted.body,
    notes: [
      `parsed.attachments.length=${parsed.attachments?.length ?? 0}`,
      `data.hasAttachments=${String(payloadObj.data?.hasAttachments)}`,
      `leaked_content_keys=${JSON.stringify(leaked)}`,
      '锚点 webhook-sink.ts:227；webhook-delivery.ts:1532 formatMailPayload',
    ],
  });

  deliveryQueue.cancelAll();
}

// ========== 附：MCP mail_send 同验 ==========
section('MCP mail_send 携 attachments[]');
{
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 319,
      method: 'tools/call',
      params: {
        name: 'mail_send',
        arguments: {
          from,
          to: 'recipient@example.net',
          subject: '319-mcp-att',
          text: 'mcp-hello',
          attachments: [{ content: 'YQ==', filename: 'a.txt' }],
        },
      },
    }),
  });
  const mcpBody = await readMcpJson(res);
  record({
    id: 'MCP',
    title: 'MCP tools/call mail_send + attachments[]',
    expectedNote: '工具 inputSchema 无 attachments；服务端 zod 默认剥未知键（见 mcp-http.test 注释）',
    requestSummary: { path: '/mcp', tool: 'mail_send', hasAttachmentsKey: true },
    status: res.status,
    bodyText: JSON.stringify(mcpBody).slice(0, 1200),
    notes: [
      '锚点 packages/api/src/mcp/tools.ts:531-548',
      '无独立附件 MCP 入口',
    ],
  });

  // tools/list 确认 mail_send schema 无 attachments
  const listRes = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 320, method: 'tools/list', params: {} }),
  });
  const listBody = (await readMcpJson(listRes)) as {
    result?: { tools?: Array<{ name: string; inputSchema?: unknown }> };
  };
  const mailSend = listBody.result?.tools?.find((t) => t.name === 'mail_send');
  log(`  mail_send.inputSchema=${JSON.stringify(mailSend?.inputSchema)}`);
  record({
    id: 'MCP-schema',
    title: 'tools/list 中 mail_send.inputSchema 是否含 attachments',
    expectedNote: '不应出现 attachments 属性',
    requestSummary: { method: 'tools/list' },
    status: listRes.status,
    bodyText: JSON.stringify(mailSend?.inputSchema ?? null),
    notes: [
      `hasAttachmentsProp=${JSON.stringify(
        !!(mailSend?.inputSchema as { properties?: Record<string, unknown> } | undefined)
          ?.properties?.attachments,
      )}`,
    ],
  });
}

// ========== 附：消息/线程下载端点存在性 ==========
section('消息/线程附件下载端点存在性（路由面）');
{
  const paths = [
    `/v1/messages/31901/attachments/att_1?address=${encodeURIComponent(from)}`,
    `/v1/threads/thr_1/attachments/att_1?address=${encodeURIComponent(from)}`,
  ];
  for (const path of paths) {
    const res = await app.request(path, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    const text = await res.text();
    record({
      id: `ROUTE-${path.split('?')[0]}`,
      title: `GET ${path.split('?')[0]}`,
      expectedNote: '无附件下载路由 → 404 或未匹配',
      requestSummary: { path },
      status: res.status,
      bodyText: text.slice(0, 400),
      notes: ['messages 路由仅 GET /、GET /:id、POST /:id/seen、POST /wait'],
    });
  }
}

const finishedAt = new Date().toISOString();
log('');
log(`#319 probe finished ${finishedAt}`);

const summaryPath = join(OUT_DIR, 'probe-results.json');
writeFileSync(
  summaryPath,
  JSON.stringify({ startedAt: STARTED_AT, finishedAt, results }, null, 2),
  'utf8',
);
const stdoutPath = join(OUT_DIR, 'probe-stdout.txt');
writeFileSync(stdoutPath, logLines.join('\n') + '\n', 'utf8');
log(`wrote ${summaryPath}`);
log(`wrote ${stdoutPath}`);
