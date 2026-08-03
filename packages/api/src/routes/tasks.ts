import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getAuth } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import { acquireWaitSlot, releaseWaitSlot } from '../lib/ratelimit.ts';
import {
  TASK_STATES,
  type Task,
  type TaskService,
  taskParticipants,
  taskService,
} from '../lib/tasks.ts';

const taskStateSchema = z.enum(TASK_STATES);
const taskIdSchema = z.string().uuid();

const createSchema = z.object({
  // Identity callers derive this from their scoped token. Admin callers must
  // state it explicitly so an admin key never silently impersonates one.
  from: z.string().email().optional(),
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  wait: z.boolean().optional(),
}).strict();

const updateSchema = z.object({
  from: z.string().email().optional(),
  state: taskStateSchema,
  body: z.string().max(1_000_000).optional(),
  // A task result is serialized by the API into a JSON block in the reply
  // body. It replaces attachments until v0.5 blob storage exists.
  result: z.unknown().optional(),
}).strict();

const listSchema = z.object({ state: taskStateSchema.optional() });
const getSchema = z.object({ wait: z.enum(['true', 'false']).optional() });

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
  return auth.kind === 'admin' || taskParticipants(task).has(auth.address);
}

async function waitWithSlot(
  c: Context,
  service: TaskService,
  task: Task,
  address: string,
): Promise<Task | null | Response> {
  // Task waits hold the same kind of long-lived IMAP IDLE connection as
  // mail_wait_for. They must share its per-address/global ceiling.
  if (!acquireWaitSlot(address)) {
    return c.json({ error: 'too_many_waits', retryAfterSec: 5 }, 429);
  }
  try {
    return await service.waitForTerminal(task.id, address);
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

  function known(c: Context, address: string): Response | null {
    const domain = address.split('@')[1]?.toLowerCase();
    if (domain !== config.domain || !find(address)) {
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
        const task = await service.create({
          from,
          to: parsed.data.to.toLowerCase(),
          subject: parsed.data.subject,
          body: parsed.data.body,
        });
        if (!parsed.data.wait) return c.json(task, 201);
        // `wait` deliberately has one capped server turn. Long tasks are
        // resumed by asking task_get or calling task_create(wait) again.
        const waited = await waitWithSlot(c, service, task, from);
        if (waited instanceof Response) return waited;
        return c.json(waited ?? task, 201);
      } catch (err) {
        console.warn('[task] create failed:', (err as Error).message);
        return c.json({ error: 'smtp_error' }, 502);
      }
    })
    .get('/', async (c) => {
      const parsed = listSchema.safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      const tasks = await service.list(parsed.data.state);
      const auth = getAuth(c);
      return c.json({
        tasks: auth.kind === 'admin'
          ? tasks
          : tasks.filter((task) => taskParticipants(task).has(auth.address)),
      });
    })
    .get('/:id', async (c) => {
      const parsed = taskIdSchema.safeParse(c.req.param('id'));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const query = getSchema.safeParse(c.req.query());
      if (!query.success) return c.json({ error: 'invalid_request', details: query.error.issues }, 400);
      const task = await service.get(parsed.data);
      if (!task) return c.json({ error: 'not_found' }, 404);
      if (!canReadTask(c, task)) return c.json({ error: 'forbidden: task participant required' }, 403);
      if (query.data.wait !== 'true') return c.json(task);
      const auth = getAuth(c);
      const address = auth.kind === 'identity' ? auth.address : task.from;
      const waited = await waitWithSlot(c, service, task, address);
      if (waited instanceof Response) return waited;
      return c.json(waited ?? task);
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
      const task = await service.get(id.data);
      if (!task) return c.json({ error: 'not_found' }, 404);
      // This is a hard server-side ACL boundary. A guessed task UUID alone
      // never gives another identity authority to advance its state.
      if (!taskParticipants(task).has(from)) {
        return c.json({ error: 'forbidden: task participant required' }, 403);
      }
      try {
        const updated = await service.update({
          id: id.data,
          from,
          state: parsed.data.state,
          ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
          ...(parsed.data.result !== undefined ? { result: parsed.data.result } : {}),
        });
        if (!updated) return c.json({ error: 'not_found' }, 404);
        return c.json(updated);
      } catch (err) {
        if ((err as Error).message === 'task_already_terminal') {
          return c.json({ error: 'task_already_terminal' }, 409);
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
