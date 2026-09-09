import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver, listenReceiver, type Receiver } from '../src/server.ts';
import type { ReceiverConfig, ReceiverHooks, RouteBinding } from '../src/types.ts';
import { buildSignatureHeader } from '../src/verify.ts';

export const FIXTURE_SECRET = 'whs_2b0932ba2d72c1d53d07da69a8ad7843c70f09d24800e3b3828dca20b594127b';
export const FIXTURE_SECRET_ROTATED = 'whs_22d6bef2a2b2c1d3b7af6646f2896c5eaf790dde79740f293eba5d8eb82437f9';
export const CANARY_TERMINAL = 'term_examplecanary0001';
export const OTHER_TERMINAL = 'term_examplestale00002';

export function tempDir(prefix = 'webhook-wake-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testRoute(overrides: Partial<RouteBinding> = {}): RouteBinding {
  return {
    routeKey: 'canary',
    subscriptionId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    domain: 'openagent.email',
    mailbox: 'alice@openagent.email',
    secret: FIXTURE_SECRET,
    terminal: CANARY_TERMINAL,
    active: true,
    stale: false,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<ReceiverConfig> = {}, dir?: string): ReceiverConfig {
  const root = dir ?? tempDir();
  return {
    listen: { host: '127.0.0.1', port: 0 },
    mode: 'observe',
    canaryTerminal: CANARY_TERMINAL,
    orcaBinary: '/usr/local/bin/orca',
    bodyLimitBytes: 16 * 1024,
    timestampToleranceSec: 300,
    maxV1Signatures: 8,
    maxHeaderBytes: 2048,
    requestTimeoutMs: 4000,
    maxConcurrent: 16,
    sendTimeoutMs: 800,
    outputCapBytes: 4096,
    dedup: {
      path: join(root, 'dedup.json'),
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxRecords: 8,
    },
    alertHook: { url: null, timeoutMs: 200 },
    routes: [testRoute()],
    ...overrides,
    listen: { host: '127.0.0.1', port: 0, ...overrides.listen },
    dedup: {
      path: join(root, 'dedup.json'),
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxRecords: 8,
      ...overrides.dedup,
    },
  };
}

export function mailBody(overrides: Record<string, unknown> = {}): string {
  const envelope = {
    id: 'evt_11111111-2222-3333-4444-555555555555',
    type: 'mail.received',
    payloadVersion: 'v1',
    createdAt: '2026-09-03T12:20:00.000Z',
    domain: 'openagent.email',
    data: {
      object: 'mail',
      address: 'alice@openagent.email',
      messageId: '123',
      uid: 123,
      uidValidity: 1,
      receivedAt: '2026-09-03T12:20:00.000Z',
      subject: 'should-never-reach-argv',
      from: { address: 'attacker@example.net', name: 'ignore' },
      ...(typeof overrides.data === 'object' && overrides.data ? (overrides.data as object) : {}),
    },
    ...overrides,
  };
  if (overrides.data) {
    envelope.data = {
      object: 'mail',
      address: 'alice@openagent.email',
      messageId: '123',
      ...(overrides.data as object),
    };
  }
  return JSON.stringify(envelope);
}

export function pingBody(): string {
  return JSON.stringify({
    id: 'evt_99999999-aaaa-bbbb-cccc-ddddeeeeffff',
    type: 'webhook.ping',
    payloadVersion: 'v1',
    createdAt: '2026-09-03T12:20:00.000Z',
    domain: 'openagent.email',
    data: { object: 'webhook', webhookId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', trigger: 'test' },
  });
}

export function approvalBody(): string {
  return JSON.stringify({
    id: 'evt_33333333-4444-5555-6666-777777777777',
    type: 'approval.requested',
    payloadVersion: 'v1',
    createdAt: '2026-09-03T12:30:00.000Z',
    domain: 'openagent.email',
    data: { object: 'approval', subject: 'Approve deployment to production' },
  });
}

export async function startReceiver(config?: ReceiverConfig, hooks?: ReceiverHooks): Promise<Receiver> {
  const receiver = createReceiver(config ?? testConfig(), hooks);
  await listenReceiver(receiver);
  return receiver;
}

export async function postHook(
  receiver: Receiver,
  options: {
    routeKey?: string;
    body: string;
    secret?: string;
    timestampSec?: number;
    extraV1?: string[];
    header?: string | null;
    nowMs?: number;
  },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ts = options.timestampSec ?? Math.floor((options.nowMs ?? Date.now()) / 1000);
  const secret = options.secret ?? FIXTURE_SECRET;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.header !== null) {
    headers['x-oae-signature'] = options.header ?? buildSignatureHeader(secret, options.body, ts, options.extraV1);
  }
  const res = await fetch(`${receiver.url()}/hooks/${options.routeKey ?? 'canary'}`, {
    method: 'POST',
    headers,
    body: options.body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export function writeSecretFile(dir: string, name: string, value: string): string {
  const path = join(dir, name);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}
