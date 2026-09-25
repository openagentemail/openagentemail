process.env.BUN_TEST = '1';
process.env.DOMAIN = 'test.example';
process.env.EXTRA_DOMAINS = 'extra.test';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { config, parseConfig } = await import('../src/lib/config.ts');
const {
  createForwardingRule,
  deleteForwardingRule,
  deleteForwardingRulesForAddress,
  digestForwardingVerificationCode,
  FORWARD_STORE_FILE,
  getForwardingRule,
  getForwardingRuleByAddress,
  listForwardingRules,
  readForwardingStore,
  resetForwardingStoreForTests,
  setForwardingFailClosedForTests,
  setForwardingWriteHookForTests,
  updateForwardingRule,
  writeForwardingStore,
  ForwardStoreCorruptError,
  ForwardStoreError,
} = await import('../src/lib/forward-store.ts');

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-forward-store-'));
const originalDataDir = config.dataDir;
const known = new Set(['alice@test.example', 'bob@test.example']);
const identityExists = (address: string) => known.has(address.toLowerCase());

function setupTestDir(): void {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
  (config as { dataDir: string }).dataDir = TEST_DATA_DIR;
  // 合跑时补 EXTRA 域与显式钥，避免单例锁死导致 HMAC 回退 SMTP_PASS。
  (config as { allDomains: Set<string> }).allDomains.add('extra.test');
  (config as { taskSigningSecretExplicit?: string }).taskSigningSecretExplicit =
    '01234567890123456789012345678901';
  resetForwardingStoreForTests();
}

function storeFile(): string {
  return join(config.dataDir, FORWARD_STORE_FILE);
}

/** 脚手架：建规则；负控断言仍在各 test 内。 */
function createRule(address: string, destination: string, extra: Record<string, unknown> = {}) {
  return createForwardingRule({ address, destination, identityExists, ...extra });
}

function resetScratch(): void {
  resetForwardingStoreForTests();
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
}

function seedStore(payload: unknown): void {
  resetScratch();
  writeFileSync(storeFile(), typeof payload === 'string' ? payload : JSON.stringify(payload), {
    mode: 0o600,
  });
}

function fixtureRule(over: Record<string, unknown> = {}) {
  return {
    id: 'fwd_ok',
    address: 'alice@test.example',
    destination: 'user@gmail.com',
    state: 'pending_verification',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    verifiedAt: null,
    verification: null,
    ...over,
  };
}

describe('#106 A1 forwarding store', () => {
  beforeEach(setupTestDir);

  afterEach(() => {
    resetForwardingStoreForTests();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    resetForwardingStoreForTests();
    (config as { dataDir: string }).dataDir = originalDataDir;
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('default config has no outbound path', () => {
    const parsed = parseConfig({
      DOMAIN: 'example.com',
      API_KEYS: 'admin-key',
      IMAP_USER: 'catch-all@example.com',
      IMAP_PASS: 'imap-secret',
      SMTP_USER: 'catch-all@example.com',
      SMTP_PASS: 'smtp-secret',
    });
    expect(parsed.forwarding.enabled).toBe(false);
    expect(Object.keys(parsed.forwarding)).toEqual(['enabled']);
    const src = readFileSync(new URL('../src/lib/forward-store.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/getMessageSource|sendMail|notification-watcher|from ['"].*smtp/);
    expect(src).not.toMatch(/from ['"].*app\.ts|from ['"].*imap\.ts/);
  });

  test('compose and example env default FORWARDING_ENABLED to false', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    for (const file of ['compose.yaml', 'compose.api-only.yaml']) {
      expect(readFileSync(join(root, file), 'utf8')).toMatch(
        /^\s+FORWARDING_ENABLED:\s*\$\{FORWARDING_ENABLED:-false\}\s*$/m,
      );
    }
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toMatch(/^FORWARDING_ENABLED=false$/m);
  });

  test('missing file is empty; 0700/0600; restart reads back', () => {
    expect(readForwardingStore().rules).toEqual([]);
    const created = createRule('Alice@test.example', 'user@gmail.com');
    expect((statSync(TEST_DATA_DIR).mode & 0o777)).toBe(0o700);
    expect((statSync(storeFile()).mode & 0o777)).toBe(0o600);
    expect(created.state).toBe('pending_verification');
    expect(created.verification).toBeNull();
    expect(created.verifiedAt).toBeNull();
    setForwardingFailClosedForTests(false);
    const again = getForwardingRuleByAddress('alice@test.example');
    expect(again?.id).toBe(created.id);
    expect(again?.destination).toBe('user@gmail.com');
    expect(JSON.parse(readFileSync(storeFile(), 'utf8')).rules).toHaveLength(1);
  });

  test('rejects unknown identity, instance/control/duplicate destinations', () => {
    expect(() => createRule('ghost@test.example', 'user@gmail.com')).toThrow(
      new ForwardStoreError('identity_not_found', 'identity not found'),
    );
    expect(() => createRule('alice@test.example', 'other@test.example')).toThrow(ForwardStoreError);
    expect(() => createRule('alice@test.example', 'x@extra.test')).toThrow(ForwardStoreError);
    expect(() => createRule('alice@test.example', 'user@gmail.com\n')).toThrow(ForwardStoreError);
    createRule('alice@test.example', 'user@gmail.com');
    expect(() => createRule('alice@test.example', 'other@outlook.com')).toThrow(
      new ForwardStoreError('duplicate_rule', 'forwarding rule already exists'),
    );
  });

  test('identity lookup throw fail-closes create; no destination in error', () => {
    try {
      createForwardingRule({
        address: 'alice@test.example',
        destination: 'secret-dest@gmail.com',
        identityExists: () => {
          throw new Error('identity store down');
        },
      });
      throw new Error('expected reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ForwardStoreError);
      expect((error as { code?: string }).code).toBe('identity_lookup_failed');
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('secret-dest@gmail.com');
      expect(message).not.toContain('identity store down');
    }
    expect(existsSync(storeFile())).toBe(false);
  });

  test('verification stores digest only; plaintext keys rejected', () => {
    const digest = digestForwardingVerificationCode('alice@test.example', '123456');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const expiresAt = '2030-01-01T00:00:00.000Z';
    const rule = createRule('alice@test.example', 'user@gmail.com', { verification: { digest, expiresAt } });
    expect(readFileSync(storeFile(), 'utf8')).not.toContain('123456');
    expect(getForwardingRule(rule.id)?.verification).toEqual({ digest, expiresAt });
    expect(() =>
      updateForwardingRule(rule.id, { verification: { digest, expiresAt, code: '123456' } as never }),
    ).toThrow(ForwardStoreError);
    expect(getForwardingRule(rule.id)?.verification).toEqual({ digest, expiresAt });
    const prevExplicit = (config as { taskSigningSecretExplicit?: string }).taskSigningSecretExplicit;
    (config as { taskSigningSecretExplicit?: string }).taskSigningSecretExplicit = undefined;
    try {
      expect(() => digestForwardingVerificationCode('alice@test.example', '123456')).toThrow(
        ForwardStoreError,
      );
    } finally {
      (config as { taskSigningSecretExplicit?: string }).taskSigningSecretExplicit = prevExplicit;
    }
  });

  test('load rejects plaintext verification; four states persist', () => {
    const rule = createRule('alice@test.example', 'user@gmail.com');
    expect(() => updateForwardingRule(rule.id, { state: 'active' })).toThrow(ForwardStoreError);
    const verifiedAt = '2030-01-01T00:00:00.000Z';
    expect(updateForwardingRule(rule.id, { state: 'active', verifiedAt }).state).toBe('active');
    expect(updateForwardingRule(rule.id, { state: 'paused' }).state).toBe('paused');
    expect(updateForwardingRule(rule.id, { state: 'disabled' }).state).toBe('disabled');
    expect(getForwardingRule(rule.id)?.state).toBe('disabled');
    known.add('cara@extra.test');
    expect(createRule('cara@extra.test', 'cara@gmail.com').address).toBe('cara@extra.test');
    seedStore({ schemaVersion: 1, rules: [fixtureRule({ id: 'fwd_bad', verification: '123456' })] });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    expect(readFileSync(storeFile(), 'utf8')).toContain('123456');
  });

  test('corrupt and unknown version fail-closed; no empty-table fallback', () => {
    createRule('alice@test.example', 'user@gmail.com');
    writeFileSync(storeFile(), 'NOT JSON', { mode: 0o600 });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    expect(() => listForwardingRules()).toThrow(ForwardStoreCorruptError);
    expect(() => createRule('bob@test.example', 'bob@gmail.com')).toThrow(ForwardStoreCorruptError);
    expect(readFileSync(storeFile(), 'utf8')).toBe('NOT JSON');
    seedStore({ schemaVersion: 99, rules: [] });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    expect(() => deleteForwardingRulesForAddress('alice@test.example')).toThrow(
      ForwardStoreCorruptError,
    );
  });

  test('empty existing file fail-closes; mid-write failure keeps disk and memory', () => {
    writeFileSync(storeFile(), '', { mode: 0o600 });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    resetScratch();
    const first = createRule('alice@test.example', 'user@gmail.com');
    const before = readFileSync(storeFile());
    setForwardingWriteHookForTests(() => {
      throw new Error('injected_mid_write');
    });
    expect(() => createRule('bob@test.example', 'bob@gmail.com')).toThrow('injected_mid_write');
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
    expect(getForwardingRule(first.id)?.address).toBe('alice@test.example');
    expect(existsSync(`${storeFile()}.tmp`)).toBe(false);
    expect(listForwardingRules()).toHaveLength(1);
  });

  test('delete primitive is fail-closed and usable before identity delete', () => {
    createRule('alice@test.example', 'user@gmail.com');
    createRule('bob@test.example', 'bob@gmail.com');
    const removed = deleteForwardingRulesForAddress('ALICE@test.example');
    expect(removed).toHaveLength(1);
    expect(getForwardingRuleByAddress('alice@test.example')).toBeUndefined();
    expect(listForwardingRules()).toHaveLength(1);
    expect(deleteForwardingRule(listForwardingRules()[0]!.id)?.address).toBe('bob@test.example');
    expect(listForwardingRules()).toEqual([]);
    writeFileSync(storeFile(), '{', { mode: 0o600 });
    expect(() => deleteForwardingRulesForAddress('alice@test.example')).toThrow(
      ForwardStoreCorruptError,
    );
  });

  test('R1 invariant: corrupt disk fail-closes; write reject leaves bytes', () => {
    for (const rule of [
      fixtureRule({ destination: 'other@test.example' }),
      fixtureRule({ destination: 'not a mailbox' }),
      fixtureRule({ state: 'active', verifiedAt: null }),
    ]) {
      seedStore({ schemaVersion: 1, rules: [rule] });
      expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
      expect(() => listForwardingRules()).toThrow(ForwardStoreCorruptError);
    }
    seedStore({
      schemaVersion: 1,
      rules: [fixtureRule(), fixtureRule({ id: 'fwd_dup', destination: 'two@gmail.com' })],
    });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    seedStore({
      schemaVersion: 1,
      rules: [fixtureRule(), fixtureRule({ address: 'bob@test.example', destination: 'b@gmail.com' })],
    });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    resetScratch();
    const good = createRule('alice@test.example', 'user@gmail.com');
    const before = readFileSync(storeFile());
    expect(() =>
      writeForwardingStore({ schemaVersion: 1, rules: [{ ...good, destination: 'loop@test.example' }] }),
    ).toThrow(ForwardStoreError);
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
    expect(getForwardingRule(good.id)?.destination).toBe('user@gmail.com');
  });

  test('R1 persist: chmod/dir-fsync failure is visible and does not leak dest', () => {
    const first = createRule('alice@test.example', 'KeepCase@gmail.com');
    expect(first.destination).toBe('KeepCase@gmail.com');
    expect(getForwardingRule(first.id)?.destination).toBe('KeepCase@gmail.com');
    const before = readFileSync(storeFile());
    setForwardingWriteHookForTests((phase) => {
      if (phase === 'chmod-tmp') throw new Error('injected_chmod');
    });
    try {
      createRule('bob@test.example', 'secret-dest@gmail.com');
      throw new Error('expected reject');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('secret-dest@gmail.com');
      expect((error as { code?: string }).code).toBe('persist_failed');
    }
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
    expect(existsSync(`${storeFile()}.tmp`)).toBe(false);
    setForwardingWriteHookForTests((phase) => {
      if (phase === 'dir-fsync') throw new Error('injected_dir_fsync');
    });
    try {
      createRule('bob@test.example', 'bob@gmail.com');
      throw new Error('expected reject');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('persist_failed');
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('bob@gmail.com');
    }
    expect(() => listForwardingRules()).toThrow(ForwardStoreCorruptError);
  });

  test('R1 destination keeps local-part case and rejects illegal local-part', () => {
    const created = createRule('alice@test.example', 'User.Name+Tag@Gmail.COM');
    expect(created.destination).toBe('User.Name+Tag@gmail.com');
    expect(getForwardingRuleByAddress('alice@test.example')?.destination).toBe('User.Name+Tag@gmail.com');
    expect(() => createRule('bob@test.example', 'user,name@gmail.com')).toThrow(ForwardStoreError);
    expect(() => createRule('bob@test.example', '<bob@gmail.com>')).toThrow(ForwardStoreError);
    expect(() => createRule('bob@test.example', 'a..b@gmail.com')).toThrow(ForwardStoreError);
  });

  test('R1 reset helper refuses to wipe a non-tmp DATA_DIR', () => {
    createRule('alice@test.example', 'user@gmail.com');
    const before = readFileSync(storeFile());
    const prev = config.dataDir;
    (config as { dataDir: string }).dataDir = '/app/data';
    try {
      expect(() => resetForwardingStoreForTests()).toThrow(ForwardStoreError);
    } finally {
      (config as { dataDir: string }).dataDir = prev;
    }
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
    expect(getForwardingRuleByAddress('alice@test.example')?.destination).toBe('user@gmail.com');
  });

  test('R2: case-folded identity dup, schemaVersion write reject, test-only seams', () => {
    const alice = fixtureRule({ id: 'fwd_a', address: 'Alice@test.example' });
    seedStore({ schemaVersion: 1, rules: [alice, { ...alice, id: 'fwd_b', address: 'alice@test.example' }] });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    resetScratch();
    const good = createRule('alice@test.example', 'user@gmail.com');
    const before = readFileSync(storeFile());
    // 运行时拒未知版本；类型面上 schemaVersion 已钉死为 1，故 as never 模拟 raw write。
    expect(() => writeForwardingStore({ schemaVersion: 99, rules: [good] } as never)).toThrow(
      ForwardStoreError,
    );
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
    expect(() =>
      writeForwardingStore({
        schemaVersion: 1,
        rules: [good, { ...good, id: 'fwd_x', address: 'Alice@test.example' }],
      }),
    ).toThrow(ForwardStoreError);
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
    const prevBun = process.env.BUN_TEST;
    delete process.env.BUN_TEST;
    try {
      expect(() => resetForwardingStoreForTests()).toThrow(ForwardStoreError);
      expect(() => setForwardingFailClosedForTests(true)).toThrow(ForwardStoreError);
      expect(() => setForwardingWriteHookForTests(() => undefined)).toThrow(ForwardStoreError);
    } finally {
      process.env.BUN_TEST = prevBun;
    }
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
  });
});
