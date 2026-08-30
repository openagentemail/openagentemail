/** Durable task IDs are UUID versions 1–5 with an RFC 4122 variant. */
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTaskId(value: string): boolean {
  return TASK_ID_RE.test(value);
}
