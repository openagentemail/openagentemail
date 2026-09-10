import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getAuth } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import { taskLeasePendingJournalEnabled, taskLeasesEnabled } from '../lib/task-lease-gate.ts';
import { acquireWaitSlot, releaseWaitSlot } from '../lib/ratelimit.ts';
import { readTaskForAuthorization, shouldMaterializeAuthorizedTask } from '../lib/task-authorization-read.ts';
import {
  TASK_STATES,
  type Task,
  type TaskService,
  TASK_LEASE_MAX_SEC,
  TASK_LEASE_REASON_MAX_CHARS,
  TASK_LEASE_MIN_SEC,
  isTaskId,
  taskParticipants,
  taskService,
  toTaskLeaseGrantView,
  toTaskView,
} from '../lib/tasks.ts';

const taskStateSchema = z.enum(TASK_STATES);
const taskIdSchema = z.string().uuid();

const createSchema = z.object({
  // Identity callers derive this from their scoped token. Admin callers must
  // state it explicitly so an admin key never silently impersonates one.
  from: z.string().email().optional(),
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000).optional(),
  parentTaskId: z.string().refine(isTaskId).optional(),
  /** Additive #55 request creation; decision route stays frozen for R3. */
  kind: z.literal('approval').optional(),
  approval: z.object({
    action: z.object({
      type: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      arguments: z.unknown(),
    }).strict(),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict().optional(),
  wait: z.boolean().optional(),
}).strict();

const updateSchema = z.object({
  from: z.string().email().optional(),
  state: taskStateSchema,
  body: z.string().max(1_000_000).optional(),
  // A task result is serialized by the API into a JSON block in the reply
  // body. It replaces attachments until v0.5 blob storage exists.
  result: z.unknown().optional(),
  // R5: undefined is the only omission signal. A supplied empty/malformed
  // token reaches the shared active-lease fence and gets task_lease_required.
  leaseToken: z.string().optional(),
}).strict();

const claimSchema = z.object({
  leaseSec: z.number().int().min(TASK_LEASE_MIN_SEC).max(TASK_LEASE_MAX_SEC).optional(),
}).strict();

const renewLeaseSchema = z.object({
  leaseToken: z.string().min(1),
  leaseSec: z.number().int().min(TASK_LEASE_MIN_SEC).max(TASK_LEASE_MAX_SEC).optional(),
}).strict();

const releaseLeaseSchema = z.object({
  leaseToken: z.string().min(1),
  reason: z.string().max(TASK_LEASE_REASON_MAX_CHARS).optional(),
}).strict();

const decisionSchema = z.object({
  from: z.string().email().optional(),
  decision: z.enum(['approved', 'rejected']),
}).strict();

const listSchema = z.object({ state: taskStateSchema.optional() });
const getSchema = z.object({ wait: z.enum(['true', 'false']).optional() });
// children 游标与 board cursor 同口径：解码前硬限 1024，超长直接 400。
const childrenSchema = z.object({
  limit: z.coerce.number().refine((value) => value === 20 || value === 50 || value === 100).optional(),
  cursor: z.string().max(1024).optional(),
});

function actorAddress(c: Context, supplied: string | undefined): string | Response {
  const auth = getAuth(c);
  if (auth.kind === 'identity') {
    if (supplied && supplied.toLowerCase() !== auth.address) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }
    return auth.address;
  }
  if (!supplied) return c.json({ error: 'from is required for an admin key' }, 400);
  return supplied.toLowerCase();
}

function canReadTask(c: Context, task: Task): boolean {
  const auth = getAuth(c);
  // 参与者比较一律小写，避免 identity token 大小写与 IMAP 地址不一致。
  return auth.kind === 'admin' || taskParticipants(task).has(auth.address.toLowerCase());
}

function journalUnavailable(c: Context, err: unknown): Response | null {
  const code = (err as Error).message;
  if (code.startsWith('lease_journal_')) return c.json({ error: code }, 503);
  return null;
}

/** Relationship edges are independently ACL-scoped; the base task stays readable. */
function taskViewFor(c: Context, task: Task, parent: Task | null | undefined) {
  const view = toTaskView(task);
  return task.parentTaskId && parent && canReadTask(c, parent)
    ? { ...view, parentTaskId: task.parentTaskId }
    : view;
}

/** mutation 成功响应与 GET/create 共用独立 parent ACL 投影，不暴露内部 root。 */
async function mutationTaskView(c: Context, service: TaskService, task: Task) {
  return taskViewFor(c, task, await projectedParentTask(service, task.parentTaskId));
}

async function projectedParentTask(service: TaskService, parentTaskId: string | undefined): Promise<Task | null> {
  if (!parentTaskId) return null;
  try {
    return await readTaskForAuthorization(service, parentTaskId);
  } catch {
    // Parent edges are optional ACL projections. A transient read must not
    // fail an already-durable create or an otherwise-readable child GET.
    return null;
  }
}

async function waitWithSlot(
  c: Context,
  service: TaskService,
  task: Task,
  address: string,
): Promise<Task | null | Response> {
  // Task waits hold the same kind of long-lived IMAP IDLE connection as
  // mail_wait_for. They must share its per-address/global ceiling.
  // 封顶与 mail_wait_for 同源：MCP_MAX_WAIT_SECONDS（静默钳制）。
  const waitSec = config.mcpMaxWaitSeconds;
  c.header('X-OAE-Wait-Timeout-Sec', String(waitSec));
  if (!acquireWaitSlot(address)) {
    return c.json({ error: 'too_many_waits', retryAfterSec: 5 }, 429);
  }
  try {
    return await service.waitForTerminal(task.id, address, waitSec);
  } finally {
    releaseWaitSlot(address);
  }
}

export type TaskRouteOptions = {
  service?: TaskService;
  findIdentity?: typeof findIdentity;
};

export function createTaskRoutes(options: TaskRouteOptions = {}) {
  const service = options.service ?? taskService;
  const find = options.findIdentity ?? findIdentity;
  const leasesEnabled = () => taskLeasesEnabled();

  function known(c: Context, address: string): Response | null {
    const domain = address.split('@')[1]?.toLowerCase();
    if (!domain || !config.allDomains.has(domain) || !find(address)) {
      return c.json({ error: 'forbidden: task participants must be known identities' }, 403);
    }
    return null;
  }

  return new Hono()
    .post('/', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      if (parsed.data.kind === 'approval' && !parsed.data.approval) {
        return c.json({ error: 'invalid_request: approval is required for approval tasks' }, 400);
      }
      if (parsed.data.kind !== 'approval' && (parsed.data.approval || parsed.data.body === undefined)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const from = actorAddress(c, parsed.data.from);
      if (from instanceof Response) return from;
      const sender = known(c, from);
      if (sender) return sender;
      const recipient = known(c, parsed.data.to.toLowerCase());
      if (recipient) return recipient;
      if (from === parsed.data.to.toLowerCase()) {
        return c.json({ error: 'invalid_request: task participants must differ' }, 400);
      }

      try {
        const createApproval = service.createApproval;
        if (parsed.data.kind === 'approval' && !createApproval) throw new Error('approval_service_unavailable');
        const task = parsed.data.kind === 'approval'
          ? await createApproval!({
            from,
            to: parsed.data.to.toLowerCase(),
            subject: parsed.data.subject,
            ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
            ...(parsed.data.parentTaskId !== undefined ? { parentTaskId: parsed.data.parentTaskId } : {}),
            action: parsed.data.approval!.action,
            expiresAt: parsed.data.approval!.expiresAt,
          })
          : await service.create({
            from,
            to: parsed.data.to.toLowerCase(),
            subject: parsed.data.subject,
            body: parsed.data.body!,
            ...(parsed.data.parentTaskId !== undefined ? { parentTaskId: parsed.data.parentTaskId } : {}),
          });
        const parent = await projectedParentTask(service, task.parentTaskId);
        if (!parsed.data.wait) return c.json(taskViewFor(c, task, parent), 201);
        // `wait` deliberately has one capped server turn. Long tasks are
        // resumed by asking task_get or calling task_create(wait) again.
        const waited = await waitWithSlot(c, service, task, from);
        if (waited instanceof Response) return waited;
        return c.json(taskViewFor(c, waited ?? task, parent), 201);
      } catch (err) {
        const code = (err as Error).message;
        if (code === 'invalid_approval_expiry' || code === 'invalid_parent_task_id') return c.json({ error: 'invalid_request' }, 400);
        if (code === 'parent_task_not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'parent_task_sender_not_participant') return c.json({ error: 'forbidden: task participant required' }, 403);
        if (code === 'parent_task_invalid_chain') return c.json({ error: 'task_parent_invalid' }, 409);
        if (code === 'approval_action_too_large' || code === 'approval_action_too_deep' || code === 'approval_expiry_too_far') {
          return c.json({ error: code }, 400);
        }
        console.warn('[task] create failed:', code);
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .get('/', async (c) => {
      const parsed = listSchema.safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      try {
        // One durable snapshot keeps state filtering and parent projection coherent
        // without a second IMAP scan or a state-filtered parent map.
        const allTasks = await service.list();
        const tasks = parsed.data.state === undefined
          ? allTasks
          : allTasks.filter((task) => task.state === parsed.data.state);
        const auth = getAuth(c);
        const visible = auth.kind === 'admin' ? tasks : tasks.filter((task) => taskParticipants(task).has(auth.address.toLowerCase()));
        const byId = new Map(allTasks.map((task) => [task.id, task]));
        return c.json({ tasks: visible.map((task) => taskViewFor(c, task, task.parentTaskId ? byId.get(task.parentTaskId) : null)) });
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        throw err;
      }
    })
    .get('/:id/children', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      const query = childrenSchema.safeParse(c.req.query());
      if (!id.success || !query.success) return c.json({ error: 'invalid_request' }, 400);
      // 生成 id 小写、输入大小写不敏感：lookup / filter / cursor 绑定前先归一。
      const parentTaskId = id.data.toLowerCase();
      if (!service.listChildren) return c.json({ error: 'not_found' }, 404);
      try {
        const auth = getAuth(c);
        // 单次读定版：parent 存在性与 ACL 只由 listChildren 的那次快照裁定，避免 snapshot/durable 双读竞态。
        const page = await service.listChildren({ parentTaskId, limit: (query.data.limit ?? 20) as 20 | 50 | 100, ...(query.data.cursor ? { cursor: query.data.cursor } : {}) }, auth.kind === 'admin' ? { kind: 'admin' } : { kind: 'identity', address: auth.address.toLowerCase() });
        // listChildren 成功即 viewer 可读 parent，投影 parentTaskId，不再二次读 parent。
        return c.json({
          children: page.children.map((child) => {
            const view = toTaskView(child);
            return child.parentTaskId ? { ...view, parentTaskId: child.parentTaskId } : view;
          }),
          nextCursor: page.nextCursor,
        });
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        const code = (err as Error).message;
        if (code === 'invalid_cursor') return c.json({ error: 'invalid_cursor' }, 400);
        if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'forbidden') return c.json({ error: 'forbidden: task participant required' }, 403);
        throw err;
      }
    })
    .get('/:id', async (c) => {
      const parsed = taskIdSchema.safeParse(c.req.param('id'));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const query = getSchema.safeParse(c.req.query());
      if (!query.success) return c.json({ error: 'invalid_request', details: query.error.issues }, 400);
      try {
        const authorization = await readTaskForAuthorization(service, parsed.data);
        if (!authorization) return c.json({ error: 'not_found' }, 404);
        if (!canReadTask(c, authorization)) return c.json({ error: 'forbidden: task participant required' }, 403);
        const task = shouldMaterializeAuthorizedTask(service)
          ? await service.get(parsed.data)
          : authorization;
        if (!task) return c.json({ error: 'not_found' }, 404);
        const parent = await projectedParentTask(service, task.parentTaskId);
        if (query.data.wait !== 'true') return c.json(taskViewFor(c, task, parent));
        const auth = getAuth(c);
        const address = auth.kind === 'identity' ? auth.address : task.from;
        const waited = await waitWithSlot(c, service, task, address);
        if (waited instanceof Response) return waited;
        return c.json(taskViewFor(c, waited ?? task, parent));
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        throw err;
      }
    })
    .post('/:id/claim', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_request' }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = claimSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      // Disabled direct lease operations must have no service/mutation side effect.
      if (!leasesEnabled()) return c.json({ error: 'task_leases_disabled' }, 409);
      const from = actorAddress(c, undefined);
      if (from instanceof Response) return from;
      try {
        const task = await readTaskForAuthorization(service, id.data);
        if (!task) return c.json({ error: 'not_found' }, 404);
        if (from !== task.to) return c.json({ error: 'forbidden: task recipient required' }, 403);
        const claim = service.claim;
        if (!claim) throw new Error('lease_service_unavailable');
        const grant = await claim({ id: id.data, from, leaseSec: parsed.data.leaseSec });
        const leaseView = toTaskLeaseGrantView(grant);
        return c.json({ ...leaseView, task: await mutationTaskView(c, service, grant.task) });
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        const code = (err as Error).message;
        if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'lease_recipient_required') return c.json({ error: 'forbidden: task recipient required' }, 403);
        if (code === 'lease_already_claimed' || code === 'task_not_claimable' || code === 'lease_task_cap_exhausted' || code === 'lease_overlay_pending_index') return c.json({ error: code }, 409);
        if (code === 'invalid_lease_seconds') return c.json({ error: 'invalid_request' }, 400);
        console.warn('[task] claim failed:', code);
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .post('/:id/lease', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_request' }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = renewLeaseSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      if (!leasesEnabled()) return c.json({ error: 'task_leases_disabled' }, 409);
      const from = actorAddress(c, undefined);
      if (from instanceof Response) return from;
      try {
        const task = await readTaskForAuthorization(service, id.data);
        if (!task) return c.json({ error: 'not_found' }, 404);
        if (from !== task.to) return c.json({ error: 'forbidden: task recipient required' }, 403);
        const renew = service.renew;
        if (!renew) throw new Error('lease_service_unavailable');
        return c.json(await mutationTaskView(c, service, await renew({
          id: id.data,
          from,
          leaseToken: parsed.data.leaseToken,
          ...(parsed.data.leaseSec !== undefined ? { leaseSec: parsed.data.leaseSec } : {}),
        })));
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        const code = (err as Error).message;
        if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'lease_recipient_required') return c.json({ error: 'forbidden: task recipient required' }, 403);
        if (code === 'lease_service_unavailable') return c.json({ error: 'lease_service_unavailable' }, 503);
        if (code === 'invalid_lease_seconds' || code === 'invalid_request') return c.json({ error: 'invalid_request' }, 400);
        // lease_already_released 为不可达死映射：core 对已释放 lease 发 stale_lease（错 token/reason）或 200 幂等成功。
        if (code === 'stale_lease' || code === 'task_not_claimable' || code === 'task_already_terminal' || code === 'lease_tenure_exhausted' || code === 'lease_task_cap_exhausted' || code === 'lease_overlay_pending_index') {
          return c.json({ error: code }, 409);
        }
        console.warn('[task] renew failed');
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .post('/:id/release', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_request' }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = releaseLeaseSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      if (!leasesEnabled()) return c.json({ error: 'task_leases_disabled' }, 409);
      const from = actorAddress(c, undefined);
      if (from instanceof Response) return from;
      try {
        const task = await readTaskForAuthorization(service, id.data);
        if (!task) return c.json({ error: 'not_found' }, 404);
        if (from !== task.to) return c.json({ error: 'forbidden: task recipient required' }, 403);
        const release = service.release;
        if (!release) throw new Error('lease_service_unavailable');
        return c.json(await mutationTaskView(c, service, await release({
          id: id.data,
          from,
          leaseToken: parsed.data.leaseToken,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        })));
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        const code = (err as Error).message;
        if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'lease_recipient_required') return c.json({ error: 'forbidden: task recipient required' }, 403);
        if (code === 'lease_service_unavailable') return c.json({ error: 'lease_service_unavailable' }, 503);
        if (code === 'invalid_lease_seconds' || code === 'invalid_request') return c.json({ error: 'invalid_request' }, 400);
        // 同上：不映射 core 不会发出的 lease_already_released。
        if (code === 'stale_lease' || code === 'task_not_claimable' || code === 'task_already_terminal' || code === 'lease_overlay_pending_index') {
          return c.json({ error: code }, 409);
        }
        console.warn('[task] release failed');
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .post('/:id/claim-lost', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_request' }, 400);
      if (getAuth(c).kind !== 'admin') return c.json({ error: 'forbidden: admin key required' }, 403);
      if (!leasesEnabled()) return c.json({ error: 'task_leases_disabled' }, 409);
      if (!taskLeasePendingJournalEnabled()) return c.json({ error: 'task_leases_pending_journal_disabled' }, 409);
      try {
        const task = await readTaskForAuthorization(service, id.data);
        if (!task) return c.json({ error: 'not_found' }, 404);
        const claimLost = service.claimLost;
        if (!claimLost) throw new Error('lease_service_unavailable');
        return c.json(await mutationTaskView(c, service, await claimLost({ id: id.data })));
      } catch (err) {
        const mapped = journalUnavailable(c, err);
        if (mapped) return mapped;
        const code = (err as Error).message;
        if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'lease_service_unavailable') return c.json({ error: 'lease_service_unavailable' }, 503);
        if (
          code === 'task_not_claimable'
          || code === 'lease_claim_lost_too_early'
          || code === 'lease_claim_lost_not_eligible'
          || code === 'task_leases_pending_journal_disabled'
        ) return c.json({ error: code }, 409);
        console.warn('[task] claim-lost failed:', code);
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .post('/:id/decision', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_request' }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = decisionSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      const from = actorAddress(c, parsed.data.from);
      if (from instanceof Response) return from;
      const task = await readTaskForAuthorization(service, id.data);
      if (!task) return c.json({ error: 'not_found' }, 404);
      if (!canReadTask(c, task)) return c.json({ error: 'not_found' }, 404);
      if (task.kind !== 'approval' || !task.approval) return c.json({ error: 'not_approval_task' }, 409);
      // Check the stored reviewer before calling the core; the core repeats
      // this ACL under its task lock, so neither REST nor a forged body gains
      // authority during a concurrent transition.
      if (from !== task.approval.reviewer) {
        return c.json({ error: 'forbidden: approval reviewer required' }, 403);
      }
      try {
        const decideApproval = service.decideApproval;
        if (!decideApproval) throw new Error('approval_service_unavailable');
        return c.json(await mutationTaskView(c, service, await decideApproval({
          id: id.data,
          from,
          decision: parsed.data.decision,
        })));
      } catch (err) {
        const code = (err as Error).message;
        if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
        if (code === 'approval_reviewer_required') return c.json({ error: 'forbidden: approval reviewer required' }, 403);
        if (code === 'task_expired' || code === 'task_already_decided' || code === 'not_approval_task') {
          return c.json({ error: code }, 409);
        }
        console.warn('[task] decision failed:', code);
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .post('/:id/state', async (c) => {
      const id = taskIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_request' }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = updateSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      const from = actorAddress(c, parsed.data.from);
      if (from instanceof Response) return from;
      const task = await readTaskForAuthorization(service, id.data);
      if (!task) return c.json({ error: 'not_found' }, 404);
      // This is a hard server-side ACL boundary. A guessed task UUID alone
      // never gives another identity authority to advance its state.
      if (!taskParticipants(task).has(from.toLowerCase())) {
        return c.json({ error: 'forbidden: task participant required' }, 403);
      }
      try {
        const updated = await service.update({
          id: id.data,
          from,
          state: parsed.data.state,
          ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
          ...(parsed.data.result !== undefined ? { result: parsed.data.result } : {}),
          ...(parsed.data.leaseToken !== undefined ? { leaseToken: parsed.data.leaseToken } : {}),
        });
        if (!updated) return c.json({ error: 'not_found' }, 404);
        return c.json(await mutationTaskView(c, service, updated));
      } catch (err) {
        if ((err as Error).message === 'task_already_terminal' || (err as Error).message === 'task_lease_required' || (err as Error).message === 'approval_decision_required') {
          return c.json({ error: (err as Error).message }, 409);
        }
        if ((err as Error).message === 'task_participant_required') {
          return c.json({ error: 'forbidden: task participant required' }, 403);
        }
        console.warn('[task] update failed:', (err as Error).message);
        return c.json({ error: 'smtp_error' }, 502);
      }
    });
}

export const tasksRoute = createTaskRoutes();
