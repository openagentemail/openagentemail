import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS, parseFileConfig } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';
import { isDomain, isMailbox } from '../src/ids.ts';
import { createMonitorState, stepMonitor } from '../src/monitor.ts';
import { inspectReadiness, inspectStateWritable } from '../src/readiness.ts';
import { buildSignatureHeader, verifyWebhookSignature } from '../src/verify.ts';
import { recordingWake } from '../src/wake.ts';
import {
  FIXTURE_SECRET,
  FIXTURE_SECRET_ROTATED,
  mailBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
  writeSecretFile,
} from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { FileConfig } from '../src/config.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function dacChecks(): boolean {
  return typeof process.getuid === 'function' && process.getuid() !== 0;
}

describe('R5 state directory W_OK and X_OK', () => {
  test('write-without-search and missing nested ancestor are unready; normal dir is ready', () => {
    const root = tempDir();
    const okDir = join(root, 'ok');
    mkdirSync(okDir, { mode: 0o700 });
    expect(inspectStateWritable(join(okDir, 'dedup.json'))).toBe(true);
    expect(inspectReadiness(testConfig({ dedup: { path: join(okDir, 'dedup.json') } }, okDir)).stateWritable).toBe(
      true,
    );

    const notDir = join(root, 'file-parent');
    writeFileSync(notDir, 'x', { mode: 0o600 });
    expect(inspectStateWritable(join(notDir, 'dedup.json'))).toBe(false);
    expect(inspectStateWritable(join(notDir, 'missing', 'nested', 'dedup.json'))).toBe(false);

    if (dacChecks()) {
      const locked = join(root, 'locked');
      mkdirSync(locked, { mode: 0o200 });
      expect(inspectStateWritable(join(locked, 'dedup.json'))).toBe(false);
      expect(inspectStateWritable(join(locked, 'missing', 'nested', 'dedup.json'))).toBe(false);
      chmodSync(locked, 0o700);
    }
  });
});

describe('R5 dirsync readiness inspect', () => {
  test('pending malformed or unreadable dirsync is unready; recovery clears it', async () => {
    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const marker = `${path}.dirsync`;
    writeFileSync(path, JSON.stringify({ records: {} }), { mode: 0o600 });
    writeFileSync(marker, `${join(dir)}\n`, { mode: 0o600 });
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync' });
    expect(existsSync(marker)).toBe(true);
    expect(inspectReadiness(testConfig({ dedup: { path } }, dir)).stateHealthy).toBe(false);

    writeFileSync(marker, '', { mode: 0o600 });
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync_corrupt' });
    writeFileSync(marker, 'not-absolute\n', { mode: 0o600 });
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync_corrupt' });
    expect(existsSync(marker)).toBe(true);

    if (dacChecks()) {
      chmodSync(marker, 0o000);
      expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync_unreadable' });
      chmodSync(marker, 0o600);
    }

    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    writeFileSync(marker, `${dir}\n`, { mode: 0o600 });
    await store.commit(
      {
        key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
        status: 'success',
        storedAtMs: 1,
        expiresAtMs: 9_999_999_999_999,
      },
      1,
    );
    expect(inspectDedupFile(path).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('R5 mailbox local dots and producer domain', () => {
  test('rejects leading consecutive and domain double-dot; localhost stays valid', () => {
    expect(isMailbox('alice@openagent.email')).toBe(true);
    expect(isMailbox('alice.bob+tag@openagent.email')).toBe(true);
    expect(isMailbox('alice@localhost')).toBe(true);
    expect(isDomain('localhost')).toBe(true);
    expect(isMailbox('.alice@example.com')).toBe(false);
    expect(isMailbox('alice..bob@example.com')).toBe(false);
    expect(isMailbox('alice@example..com')).toBe(false);
    expect(isMailbox('alice.@example.com')).toBe(false);

    const dir = tempDir();
    const secret = writeSecretFile(dir, 'ok.whs', FIXTURE_SECRET);
    const base = (mailbox: string): FileConfig => ({
      routes: {
        canary: {
          subscriptionId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          domain: 'example.com',
          mailbox,
          secretFile: secret,
          terminal: 'term_examplecanary0001',
        },
      },
      dedup: { retentionMs: MIN_RETENTION_MS },
    });
    expect(parseFileConfig(base('alice@localhost')).routes[0]?.mailbox).toBe('alice@localhost');
    expect(() => parseFileConfig(base('.alice@example.com'))).toThrow('config_invalid:mailbox');
    expect(() => parseFileConfig(base('alice..bob@example.com'))).toThrow('config_invalid:mailbox');
    expect(() => parseFileConfig(base('alice@example..com'))).toThrow('config_invalid:mailbox');
  });
});

describe('R5 configured signature header limits', () => {
  test('raised maxHeaderBytes accepts >2048 bytes; oversized and rotation stay correct', async () => {
    const body = mailBody();
    const ts = Math.floor(Date.now() / 1000);
    const base = buildSignatureHeader(FIXTURE_SECRET, body, ts);
    const padded = `${base},x=${'a'.repeat(2100)}`;
    expect(Buffer.byteLength(padded, 'utf8')).toBeGreaterThan(2048);

    const tight = verifyWebhookSignature({
      signatureHeader: padded,
      rawBody: body,
      secrets: [FIXTURE_SECRET],
      nowMs: ts * 1000,
      maxHeaderBytes: 2048,
    });
    expect(tight.valid).toBe(false);

    const wide = verifyWebhookSignature({
      signatureHeader: padded,
      rawBody: body,
      secrets: [FIXTURE_SECRET],
      nowMs: ts * 1000,
      maxHeaderBytes: 4096,
    });
    expect(wide.valid).toBe(true);

    const rotated = buildSignatureHeader(FIXTURE_SECRET_ROTATED, body, ts, [
      buildSignatureHeader(FIXTURE_SECRET, body, ts).split('v1=')[1] ?? '',
    ]);
    const rotation = verifyWebhookSignature({
      signatureHeader: rotated,
      rawBody: body,
      secrets: [FIXTURE_SECRET, FIXTURE_SECRET_ROTATED],
      nowMs: ts * 1000,
      maxV1: 8,
    });
    expect(rotation.valid).toBe(true);

    const receiver = await startReceiver(testConfig({ mode: 'canary', maxHeaderBytes: 4096 }), {
      wake: recordingWake([]),
    });
    receivers.push(receiver);
    const ok = await postHook(receiver, { body, header: padded });
    expect(ok.status).toBe(200);
    const small = await startReceiver(testConfig({ mode: 'canary', maxHeaderBytes: 2048 }), {
      wake: recordingWake([]),
    });
    receivers.push(small);
    const rejected = await postHook(small, { body, header: padded });
    expect(rejected.status).toBe(401);

    expect(() => parseFileConfig({ maxHeaderBytes: 0 })).toThrow('config_invalid:maxHeaderBytes');
    expect(() => parseFileConfig({ maxV1Signatures: 0 })).toThrow('config_invalid:maxV1Signatures');
    expect(parseFileConfig({ maxHeaderBytes: 4096, maxV1Signatures: 16 }).maxHeaderBytes).toBe(4096);
  });
});

describe('R5 monitor backward wall-clock', () => {
  test('future lastAlert does not mute outage; ordinary cooldown still holds', async () => {
    const alerts: string[] = [];
    const state = createMonitorState();
    state.lastAlertAtMs = 50_000;
    const cfg = { failThreshold: 1, cooldownMs: 10_000 };
    await stepMonitor({
      state,
      probe: async () => ({ ok: false }),
      alert: async (event) => {
        alerts.push(event.code);
        return { ok: true };
      },
      nowMs: 1_000,
      config: cfg,
    });
    expect(alerts).toContain('health_failed');

    const cooled = createMonitorState();
    cooled.lastAlertAtMs = 1_000;
    cooled.alarming = true;
    cooled.consecutiveFailures = 2;
    const quiet: string[] = [];
    await stepMonitor({
      state: cooled,
      probe: async () => ({ ok: false }),
      alert: async (event) => {
        quiet.push(event.code);
        return { ok: true };
      },
      nowMs: 2_000,
      config: { failThreshold: 1, cooldownMs: 10_000 },
    });
    expect(quiet).toHaveLength(0);

    const recover = createMonitorState();
    recover.alarming = true;
    recover.lastAlertAtMs = 1_000;
    const recovered: string[] = [];
    await stepMonitor({
      state: recover,
      probe: async () => ({ ok: true }),
      alert: async (event) => {
        recovered.push(event.code);
        return { ok: true };
      },
      nowMs: 20_000,
      config: { failThreshold: 1, cooldownMs: 10_000 },
    });
    expect(recovered).toContain('health_recovered');
  });

  test('shipped monitor.sh alerts when persisted last_alert is in the future', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-clock-');
    const curlFail = join(dir, 'curl-fail');
    const curlOk = join(dir, 'curl-ok');
    const alerts = join(dir, 'alerts.log');
    const alerter = join(dir, 'alert');
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(curlOk, '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
    writeFileSync(alerter, `#!/bin/sh\necho "$1" >> "${alerts}"\nexit 0\n`, { mode: 0o755 });
    const state = join(dir, 'state');
    writeFileSync(state, 'consecutive=0\nalarming=0\npending_recovery=0\nlast_alert=999999\n', { mode: 0o600 });
    const env = {
      PATH: process.env.PATH,
      HEALTH_URL: 'https://webhook-wake.example.com/health',
      FAIL_THRESHOLD: '1',
      COOLDOWN_SEC: '300',
      ALERT_BIN: alerter,
      STATE_FILE: state,
    };
    const future = spawnSync('sh', [script], {
      env: { ...env, CURL_BIN: curlFail, NOW_SEC: '100' },
      encoding: 'utf8',
    });
    expect(future.status).toBe(1);
    expect(readFileSync(alerts, 'utf8')).toContain('health_failed');

    writeFileSync(state, 'consecutive=0\nalarming=1\npending_recovery=0\nlast_alert=100\n', { mode: 0o600 });
    const cooled = spawnSync('sh', [script], {
      env: { ...env, CURL_BIN: curlFail, NOW_SEC: '110' },
      encoding: 'utf8',
    });
    expect(cooled.status).toBe(1);
    expect(readFileSync(alerts, 'utf8').trim().split('\n')).toEqual(['health_failed']);

    const recovered = spawnSync('sh', [script], {
      env: { ...env, CURL_BIN: curlOk, NOW_SEC: '500' },
      encoding: 'utf8',
    });
    expect(recovered.status).toBe(0);
    expect(readFileSync(alerts, 'utf8')).toContain('health_recovered');
  });
});
