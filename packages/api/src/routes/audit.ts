/**
 * GET /v1/audit/events — scrubbed 审计只读端点（admin only）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { readAuditEvents } from '../lib/audit.ts';
import { getAuth } from '../lib/auth.ts';

function requireAdmin(c: Context) {
  if (getAuth(c).kind !== 'admin') {
    return c.json({ error: 'forbidden: admin key required' }, 403);
  }
  return null;
}

export const auditRoute = new Hono();

auditRoute.get('/events', (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const rawLimit = c.req.query('limit');
  let limit = 100;
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 0) {
      return c.json({ error: 'invalid_request', error_description: 'limit' }, 400);
    }
    limit = Math.min(Math.floor(n), 1000);
  }
  const event = c.req.query('event') || undefined;

  return c.json({ events: readAuditEvents({ limit, event }) });
});
