/**
 * Bearer-token auth middleware. Valid keys come from the API_KEYS env
 * (comma-separated). All /v1/* routes sit behind this.
 */

import { createMiddleware } from 'hono/factory';
import { config } from './config.ts';

export const bearerAuth = createMiddleware(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token || !config.apiKeys.has(token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});
