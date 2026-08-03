#!/usr/bin/env node
/**
 * Minimal task listener: notification is only an interrupt, then this writes
 * current incoming tasks into a local JSON inbox for another process to pick
 * up. It owns no ntfy token or topic, and deliberately does not start cmux.
 *
 * OPENAGENTEMAIL_API_URL=http://localhost:3100
 * OPENAGENTEMAIL_API_KEY=oa_... (the listener identity's scoped token)
 * OPENAGENTEMAIL_IDENTITY_ADDRESS=worker@example.com
 * node examples/listener/listener.mjs
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const api = (process.env.OPENAGENTEMAIL_API_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
const key = process.env.OPENAGENTEMAIL_API_KEY;
const address = process.env.OPENAGENTEMAIL_IDENTITY_ADDRESS?.toLowerCase();
const inboxPath = resolve(process.env.OPENAGENTEMAIL_TASK_INBOX ?? './task-inbox.json');

if (!key || !address) {
  console.error('Set OPENAGENTEMAIL_API_KEY and OPENAGENTEMAIL_IDENTITY_ADDRESS first.');
  process.exit(1);
}

async function request(path) {
  const response = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function loadInbox() {
  try {
    const value = JSON.parse(readFileSync(inboxPath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveInbox(tasks) {
  mkdirSync(dirname(inboxPath), { recursive: true });
  const tmp = `${inboxPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, inboxPath);
}

async function refreshIncomingTasks() {
  const { tasks } = await request('/v1/tasks');
  // A listener only claims work delivered to its own identity. Its outgoing
  // tasks may be visible too, but belong in the caller's own task view.
  const incoming = tasks.filter((task) =>
    task.to === address && ['submitted', 'working', 'input-required'].includes(task.state),
  );
  saveInbox(incoming);
  if (incoming.length) console.log(`[listener] wrote ${incoming.length} task(s) to ${inboxPath}`);
}

async function loop() {
  try {
    // This endpoint maps the scoped identity token to its private server-side
    // agent topic. No topic name or ntfy credential enters this process.
    const { messages } = await request('/v1/notify/messages?topic=self&since=45s');
    if (messages.length) await refreshIncomingTasks();
  } catch (error) {
    console.warn('[listener] retrying:', error instanceof Error ? error.message : String(error));
  }
}

await refreshIncomingTasks();
await loop();
setInterval(loop, 15_000);
