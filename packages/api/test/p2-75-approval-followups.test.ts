// #75：list/board 过期只读投影 + approval-event-v1 展示 subject 不入签 + watcher 预筛控制。
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { simpleParser } from 'mailparser';
import type { SendInput } from '../src/lib/smtp.ts';
import type { ApprovalTask, Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-p2-75-'));

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const tasks = await import('../src/lib/tasks.ts');
const taskSeams = await import('./support/task-test-seams.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { processWatchedMessage } = await import('../src/lib/notification-watcher.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { config } = await import('../src/lib/config.ts');

const REQUESTER = 'requester@test.example';
const REVIEWER = 'reviewer@test.example';
const ID = '2c3d77bc-6e13-48bb-b470-f394cd73a60f';
const EXPIRES = '2026-08-24T00:00:00.000Z';
const BEFORE = Date.parse('2026-08-23T23:59:59.999Z');
const AT_DEADLINE = Date.parse(EXPIRES);
const DIGEST = 'a'.repeat(64);
const ACTION = { type: 'deployment', name: 'preview', arguments: { mode: 'record-only' } };

for (const localpart of ['requester', 'reviewer']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

function approvalTask(overrides: Partial<ApprovalTask> = {}): ApprovalTask {
  return {
    id: ID,
    from: REQUESTER,
    to: REVIEWER,
    subject: 'Approve preview',
    state: 'input-required',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    messages: [{
      id: '1',
      from: REQUESTER,
      to: REVIEWER,
      subject: 'Approve preview',
      date: '2026-08-23T00:00:00.000Z',
      state: 'input-required',
      body: 'record only',
      approval: {
        type: 'request',
        snapshot: { action: ACTION, reviewer: REVIEWER, expiresAt: EXPIRES, digest: DIGEST },
      },
    }],
    kind: 'approval',
    approval: { action: ACTION, reviewer: REVIEWER, expiresAt: EXPIRES, digest: DIGEST },
    ...overrides,
  };
}

function rfc822(sent: SendInput): string {
  const headers = Object.entries(sent.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return [`From: ${sent.from}`, `To: ${sent.to.join(', ')}`, `Subject: ${sent.subject}`, headers, '', sent.text].join('\r\n');
}

function header(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'));
  return match?.[1]?.trim();
}

function appFor(
  auth: { kind: 'admin' } | { kind: 'identity'; address: string },
  service: TaskService,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service,
    findIdentity: (address) => [REQUESTER, REVIEWER].includes(address.toLowerCase())
      ? { address, createdAt: '2026-08-23T00:00:00.000Z' }
      : undefined,
  }));
  return app;
}

beforeEach(() => {
  taskSeams.setTaskNowForTests(() => AT_DEADLINE);
  taskSeams.takeApprovalWatcherParseCallsForTests();
});

afterEach(() => {
  taskSeams.setTaskGetForTests(null);
  taskSeams.setTaskSendMailForTests(null);
  taskSeams.setTaskListAllForTests(null);
  taskSeams.clearQueuedEventsForTests();
  taskSeams.setTaskNowForTests(null);
});

describe('#75 Scope A: list/board 只读过期投影', () => {
  test('过期且未物化才标 past-deadline-unmaterialized；边界与 detail 物化对齐', () => {
    const pending = approvalTask();
    taskSeams.setTaskNowForTests(() => BEFORE);
    expect(tasks.toTaskView(pending)).not.toHaveProperty('expiryProjection');
    expect(tasks.toUiTaskView(pending)).not.toHaveProperty('expiryProjection');

    taskSeams.setTaskNowForTests(() => AT_DEADLINE);
    expect(tasks.toTaskView(pending).expiryProjection).toBe('past-deadline-unmaterialized');
    expect(tasks.toUiTaskView(pending).expiryProjection).toBe('past-deadline-unmaterialized');
    expect(tasks.approvalExpiryProjection(pending)).toBe(tasks.APPROVAL_EXPIRY_PROJECTION_PAST_DEADLINE);
  });

  test('已物化 expired、已决策、普通任务均不标', () => {
    const materialized = approvalTask({
      state: 'failed',
      result: { decision: 'expired', digest: DIGEST, expiredAt: EXPIRES },
      messages: [
        ...approvalTask().messages,
        {
          id: '2', from: REQUESTER, to: REVIEWER, subject: 'Approve preview',
          date: EXPIRES, state: 'failed', body: '',
          approval: { type: 'expired', digest: DIGEST },
        },
      ],
    });
    const decided = approvalTask({
      state: 'completed',
      result: { decision: 'approved', digest: DIGEST, reviewer: REVIEWER, decidedAt: '2026-08-23T12:00:00.000Z' },
    });
    const ordinary: Task = {
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Ordinary',
      state: 'submitted', createdAt: EXPIRES, updatedAt: EXPIRES,
      messages: [{ id: '1', from: REQUESTER, to: REVIEWER, subject: 'Ordinary', date: EXPIRES, state: 'submitted', body: 'x' }],
    };
    expect(tasks.toTaskView(materialized)).not.toHaveProperty('expiryProjection');
    expect(tasks.toUiTaskView(decided)).not.toHaveProperty('expiryProjection');
    expect(tasks.toTaskView(ordinary)).not.toHaveProperty('expiryProjection');
  });

  test('REST list / board 标投影且零写；authorized detail 物化后标记消失', async () => {
    const pending = approvalTask();
    const sent: SendInput[] = [];
    taskSeams.setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-75-${sent.length}@test.example>` };
    });
    taskSeams.setTaskListAllForTests(async () => [pending]);

    const board = await tasks.listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]?.expiryProjection).toBe('past-deadline-unmaterialized');
    expect(sent).toHaveLength(0);

    const listApp = appFor({ kind: 'admin' }, {
      ...tasks.taskService,
      list: async () => [pending],
    });
    const listed = await listApp.request('/v1/tasks');
    expect(listed.status).toBe(200);
    const body = await listed.json() as { tasks: Array<{ expiryProjection?: string; state: string }> };
    expect(body.tasks[0]?.expiryProjection).toBe('past-deadline-unmaterialized');
    expect(body.tasks[0]?.state).toBe('input-required');
    expect(sent).toHaveLength(0);

    taskSeams.setTaskGetForTests(async () => pending);
    const detail = await tasks.getTask(pending.id);
    expect(detail).toMatchObject({ state: 'failed', result: { decision: 'expired', digest: DIGEST } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.['X-OA-Task-Approval-Event']).toBe('expired');
    expect(tasks.toTaskView(detail!)).not.toHaveProperty('expiryProjection');
    expect(tasks.toUiTaskView(detail!)).not.toHaveProperty('expiryProjection');
  });
});

describe('#75 Scope B: display-only subject 不入 approval-event-v1', () => {
  test('不同 subject 的请求 stamp/payload 逐字节相同，且 payload 不含 subject', () => {
    const encode = tasks.encodeStampedApprovalRequestForTests;
    const a = encode({
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Display A',
      body: 'record only', action: ACTION, expiresAt: EXPIRES,
    });
    const b = encode({
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Display B — 展示层',
      body: 'record only', action: ACTION, expiresAt: EXPIRES,
    });
    const payloadA = header(a, 'X-OA-Task-Approval-Payload');
    const payloadB = header(b, 'X-OA-Task-Approval-Payload');
    const stampA = header(a, 'X-OA-Task-Stamp');
    const stampB = header(b, 'X-OA-Task-Stamp');
    expect(payloadA).toBe(payloadB);
    expect(stampA).toBe(stampB);

    const canonical = Buffer.from(payloadA!, 'base64url').toString('utf8');
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['digest', 'event', 'expiresAt', 'reviewer']);
    expect(canonical).not.toContain('subject');
    expect(canonical).not.toContain('Display');
    expect(a).toContain('Subject: Display A');
    expect(b).toContain('Subject: Display B');

    const expectedPayload = `{"digest":"${tasks.approvalActionDigest(ACTION)}","event":"request","expiresAt":"${EXPIRES}","reviewer":"${REVIEWER}"}`;
    expect(canonical).toBe(expectedPayload);
    const expectedStamp = createHmac('sha256', config.taskSigningSecret)
      .update(`approval-event-v1\n${ID}\ninput-required\n${REQUESTER}\n${REVIEWER}\n${expectedPayload}`)
      .digest('base64url');
    expect(stampA).toBe(expectedStamp);
  });

  test('文档与 stamp 注释钉死「不绑入未来版本」裁定', () => {
    const security = readFileSync(new URL('../../../docs/security.md', import.meta.url), 'utf8');
    const stamp = readFileSync(new URL('../src/lib/tasks-internal.ts', import.meta.url), 'utf8');
    expect(security).toContain('display-only `subject` 不绑入 approval-event-v1');
    expect(security).toContain('也不绑进未来 event/stamp 版本');
    expect(stamp).toContain('展示层 Subject 不进本域，也不得绑进未来 event/stamp 版本');
    expect(stamp).toContain('approval-event-v1\\n${id}\\n${state}\\n${from.toLowerCase()}\\n${to.toLowerCase()}\\n${payload}');
  });
});

describe('#75 Scope C: watcher 存在性预筛不得弱化 fail-closed', () => {
  const watcherIdentities = [{
    address: REVIEWER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 as const,
  }];

  function withHeaderVariant(source: string, extraHeader: string): string {
    return source.replace(
      'X-OA-Task-Approval-Event: request\r\n',
      `X-OA-Task-Approval-Event: request\r\n${extraHeader}\r\n`,
    );
  }

  async function watch(source: string): Promise<string[]> {
    const messages: string[] = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REQUESTER }], to: [{ address: REVIEWER }], subject: 'Approve preview' },
      headers: Buffer.from(`Delivered-To: ${REVIEWER}\r\n`),
      source: Buffer.from(source),
    } as never, watcherIdentities, 'otp', {
      publish: async (input) => {
        messages.push(input.message);
        return { target: input.target, title: input.title, level: input.level };
      },
    });
    return messages;
  }

  test('forged / duplicate / header-array 必达完整认证解析器；伪造不发审批预览', async () => {
    const authentic = tasks.encodeStampedApprovalRequestForTests({
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Approve preview',
      body: 'record only', action: ACTION, expiresAt: EXPIRES,
    });
    const forged = authentic.replace(/X-OA-Task-Stamp: [^\r\n]+/, 'X-OA-Task-Stamp: forged');
    const duplicate = withHeaderVariant(authentic, 'X-OA-Task-Approval-Event: request');
    const headerArray = withHeaderVariant(authentic, 'X-OA-Task-Approval-Event: expired');
    const ordinary = [
      `From: ${REQUESTER}`, `To: ${REVIEWER}`, 'Subject: hello',
      '', 'no approval header here',
    ].join('\r\n');

    const parsedDuplicate = await simpleParser(duplicate);
    const parsedArray = await simpleParser(headerArray);
    const parsedForged = await simpleParser(forged);
    const parsedOrdinary = await simpleParser(ordinary);
    expect(parsedDuplicate.headers.has('x-oa-task-approval-event')).toBe(true);
    expect(Array.isArray(parsedDuplicate.headers.get('x-oa-task-approval-event'))).toBe(true);
    expect(parsedArray.headers.has('x-oa-task-approval-event')).toBe(true);
    expect(Array.isArray(parsedArray.headers.get('x-oa-task-approval-event'))).toBe(true);
    expect(parsedForged.headers.has('x-oa-task-approval-event')).toBe(true);
    expect(parsedOrdinary.headers.has('x-oa-task-approval-event')).toBe(false);

    taskSeams.takeApprovalWatcherParseCallsForTests();
    const authenticMsgs = await watch(authentic);
    expect(taskSeams.takeApprovalWatcherParseCallsForTests()).toBe(1);
    expect(authenticMsgs.join('\n')).toContain('Approval request recorded.');

    const forgedMsgs = await watch(forged);
    expect(taskSeams.takeApprovalWatcherParseCallsForTests()).toBe(1);
    expect(forgedMsgs.join('\n')).not.toContain('Approval request recorded.');

    const duplicateMsgs = await watch(duplicate);
    expect(taskSeams.takeApprovalWatcherParseCallsForTests()).toBe(1);
    expect(duplicateMsgs.join('\n')).not.toContain('Approval request recorded.');

    const arrayMsgs = await watch(headerArray);
    expect(taskSeams.takeApprovalWatcherParseCallsForTests()).toBe(1);
    expect(arrayMsgs.join('\n')).not.toContain('Approval request recorded.');

    const ordinaryMsgs = await watch(ordinary);
    expect(taskSeams.takeApprovalWatcherParseCallsForTests()).toBe(0);
    expect(ordinaryMsgs).toEqual([]);
  });

  test('无热点 profile 则不加第二层负筛：源码闸门仍是 headers.has', () => {
    const watcher = readFileSync(new URL('../src/lib/notification-watcher.ts', import.meta.url), 'utf8');
    expect(watcher).toContain("parsed.headers.has('x-oa-task-approval-event')");
    expect(watcher).not.toMatch(/headers\.get\('x-oa-task-approval-event'\)\s*===\s*'string'/);
    expect(watcher).toContain('无生产 profile 证明此处是热点');
  });
});
