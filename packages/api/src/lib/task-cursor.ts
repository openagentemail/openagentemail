/**
 * Tasks 工单板游标（HMAC 不透明 token）。
 *
 * 绑定 status+period+viewer 指纹与 (updatedAt, id)，防止跨筛选串页。
 * 密钥从 taskSigningSecret 域分离派生，不新增 env。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export const TASK_BOARD_CURSOR_PREFIX = 'task-board-cursor-v1';

const cursorKey = createHmac('sha256', config.taskSigningSecret)
  .update(TASK_BOARD_CURSOR_PREFIX)
  .digest();

export class InvalidTaskCursorError extends Error {
  readonly code = 'invalid_cursor';
  constructor() {
    super('invalid_cursor');
    this.name = 'InvalidTaskCursorError';
  }
}

export type TaskBoardCursorPayload = {
  /** status|period|viewer 指纹，跨筛选必须拒绝。 */
  fp: string;
  t: number;
  id: string;
};

function cursorMac(payload: TaskBoardCursorPayload): string {
  return createHmac('sha256', cursorKey)
    .update(`${TASK_BOARD_CURSOR_PREFIX}\n${payload.fp}\n${payload.t}\n${payload.id}`)
    .digest('base64url');
}

export function encodeTaskBoardCursor(payload: TaskBoardCursorPayload): string {
  const body = Buffer.from(
    JSON.stringify({ fp: payload.fp, t: payload.t, id: payload.id }),
  ).toString('base64url');
  return `${TASK_BOARD_CURSOR_PREFIX}.${body}.${cursorMac(payload)}`;
}

export function decodeTaskBoardCursor(token: string): TaskBoardCursorPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TASK_BOARD_CURSOR_PREFIX || !parts[1] || !parts[2]) {
    throw new InvalidTaskCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTaskCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidTaskCursorError();
  const raw = parsed as { fp?: unknown; t?: unknown; id?: unknown };
  if (typeof raw.fp !== 'string' || !raw.fp) throw new InvalidTaskCursorError();
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) throw new InvalidTaskCursorError();
  if (typeof raw.id !== 'string' || !raw.id) throw new InvalidTaskCursorError();
  const payload: TaskBoardCursorPayload = { fp: raw.fp, t: raw.t, id: raw.id };
  const expected = cursorMac(payload);
  try {
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidTaskCursorError();
  } catch (err) {
    if (err instanceof InvalidTaskCursorError) throw err;
    throw new InvalidTaskCursorError();
  }
  return payload;
}
