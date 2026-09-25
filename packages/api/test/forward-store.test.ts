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
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');

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
    id: 'fwd_ok', address: 'alice@test.example', destination: 'user@gmail.com',
    state: 'pending_verification', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', verifiedAt: null, verification: null, ...over,
  };
}

/** 负控：拒写且正本不变；错误不含 leak。 */
function rejectWrite(data: unknown, leaks: string[] = []) {
  const before = readFileSync(storeFile());
  const err = (() => { try { writeForwardingStore(data as never); } catch (e) { return e; } })();
  expect(err).toBeInstanceOf(ForwardStoreError);
  for (const s of leaks) expect((err as Error).message).not.toContain(s);
  expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
}
/** 负控：拒读 fail-closed；错误不含 leak。 */
function rejectRead(leaks: string[] = []) {
  const err = (() => { try { readForwardingStore(); } catch (e) { return e; } })();
  expect(err).toBeInstanceOf(ForwardStoreCorruptError);
  for (const s of leaks) expect((err as Error).message).not.toContain(s);
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
    rejectWrite({ schemaVersion: 1, rules: [{ ...good, destination: 'loop@test.example' }] });
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
    const created = createRule('alice@test.example', ' User.Name+Tag@Gmail.COM ');
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
    (config as { dataDir: string }).dataDir = tmpdir();
    try {
      expect(() => resetForwardingStoreForTests()).toThrow(ForwardStoreError);
    } finally {
      (config as { dataDir: string }).dataDir = prev;
    }
    expect(Buffer.compare(readFileSync(storeFile()), before)).toBe(0);
  });

  test('R2: case-folded identity dup, schemaVersion write reject, test-only seams', () => {
    const alice = fixtureRule({ id: 'fwd_a', address: 'Alice@test.example' });
    seedStore({ schemaVersion: 1, rules: [alice, { ...alice, id: 'fwd_b', address: 'alice@test.example' }] });
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    resetScratch();
    const good = createRule('alice@test.example', 'user@gmail.com');
    // 运行时拒未知版本；类型面上 schemaVersion 已钉死为 1，故 as never 模拟 raw write。
    rejectWrite({ schemaVersion: 99, rules: [good] });
    rejectWrite({
      schemaVersion: 1,
      rules: [good, { ...good, id: 'fwd_x', address: 'Alice@test.example' }],
    });
    const before = readFileSync(storeFile());
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

  test('R3: raw write state/id, multi-dot dest, verification extras', () => {
    const good = createRule('alice@test.example', 'user@gmail.com');
    const leak = ['user@gmail.com', '123456'];
    rejectWrite({ schemaVersion: 1, rules: [{ ...good, state: 'forwarding' }] });
    rejectWrite({ schemaVersion: 1, rules: [{ ...good, id: 'not-fwd' }] });
    expect(() => createRule('bob@test.example', 'user@gmail.com..')).toThrow(ForwardStoreError);
    expect(() => createRule('bob@test.example', 'other@test.example.')).toThrow(ForwardStoreError);
    expect(() => createRule('alice@test.example.', 'user@gmail.com')).toThrow(ForwardStoreError);
    expect(() => createRule('alice@test.example..', 'user@gmail.com')).toThrow(ForwardStoreError);
    rejectWrite({ schemaVersion: 1, rules: [{ ...good, address: 'alice@test.example.' }] });
    const extras = {
      digest: digestForwardingVerificationCode('alice@test.example', '123456'),
      expiresAt: '2030-01-01T00:00:00.000Z',
      verification_code: '123456',
    };
    rejectWrite({ schemaVersion: 1, rules: [{ ...good, verification: extras }] }, leak);
    seedStore({ schemaVersion: 1, rules: [fixtureRule({ verification: extras })] });
    rejectRead(leak);
    seedStore({ schemaVersion: 1, rules: [fixtureRule({ address: 'alice@test.example.' })] });
    rejectRead();
    expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
    // R4 P1：根/规则未知字段（含 verification_code）读写皆拒，错误不回显。
    resetScratch();
    const keep = createRule('alice@test.example', 'user@gmail.com');
    rejectWrite({ schemaVersion: 1, rules: [keep], verification_code: '123456' }, leak);
    rejectWrite({ schemaVersion: 1, rules: [{ ...keep, verification_code: '123456' }] }, leak);
    seedStore({ schemaVersion: 1, verification_code: '123456', rules: [fixtureRule()] });
    rejectRead(leak);
    seedStore({ schemaVersion: 1, rules: [fixtureRule({ verification_code: '123456' })] });
    rejectRead(leak);
    // R4 P1：尾空白本域目的不得落盘/可读。
    resetScratch();
    const ext = createRule('alice@test.example', 'user@gmail.com');
    rejectWrite({ schemaVersion: 1, rules: [{ ...ext, destination: 'user@test.example ' }] }, [
      'user@test.example',
    ]);
    expect(getForwardingRule(ext.id)?.destination).toBe('user@gmail.com');
    seedStore({ schemaVersion: 1, rules: [fixtureRule({ destination: 'user@test.example ' })] });
    rejectRead(['user@test.example']);
  });

  test('R3: domain policy conflict is not a permanent fail-closed', () => {
    known.add('cara@extra.test');
    const extra = createRule('cara@extra.test', 'cara@gmail.com');
    const domains = (config as { allDomains: Set<string> }).allDomains;
    domains.delete('extra.test');
    try {
      rejectRead(['cara@gmail.com']);
    } finally {
      domains.add('extra.test');
    }
    expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
    expect(getForwardingRule(extra.id)?.address).toBe('cara@extra.test');
    // EXTRA 无点：点别名不是本配置身份；无点→点配变拒读无 marker，恢复可读。
    rejectWrite({ schemaVersion: 1, rules: [{ ...extra, address: 'cara@extra.test.' }] });
    domains.delete('extra.test');
    domains.add('extra.test.');
    try {
      rejectRead();
      expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
    } finally {
      domains.delete('extra.test.');
      domains.add('extra.test');
    }
    expect(getForwardingRule(extra.id)?.address).toBe('cara@extra.test');

    resetScratch();
    const alice = createRule('alice@test.example', 'user@gmail.com');
    domains.add('gmail.com');
    try {
      rejectRead(['user@gmail.com']);
    } finally {
      domains.delete('gmail.com');
    }
    expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
    expect(getForwardingRule(alice.id)?.destination).toBe('user@gmail.com');

    // R4 P2：DOMAIN=example.com. 真实点域身份可创建/读写；未配置点别名/多尾点仍拒。
    resetScratch();
    expect(parseConfig({
      DOMAIN: 'example.com.', API_KEYS: 'admin-key', IMAP_USER: 'a@example.com', IMAP_PASS: 'p',
      SMTP_USER: 'a@example.com', SMTP_PASS: 'p',
    }).domain).toBe('example.com.');
    domains.add('example.com.');
    known.add('alice@example.com.');
    try {
      const dotted = createRule('alice@example.com.', 'user@gmail.com');
      expect(dotted.address).toBe('alice@example.com.');
      writeForwardingStore({ schemaVersion: 1, rules: [dotted] });
      expect(readForwardingStore().rules[0]?.address).toBe('alice@example.com.');
      rejectWrite({ schemaVersion: 1, rules: [dotted, { ...dotted, id: 'fwd_x', address: 'alice@example.com' }] });
      rejectWrite({ schemaVersion: 1, rules: [{ ...dotted, address: 'alice@example.com' }] });
      expect(() => createRule('bob@example.com..', 'user@gmail.com')).toThrow(ForwardStoreError);
      resetScratch();
      known.add('alice@example.com');
      expect(() => createRule('alice@example.com', 'user@gmail.com')).toThrow(ForwardStoreError);
      known.delete('alice@example.com');
      seedStore({ schemaVersion: 1, rules: [fixtureRule({ address: 'alice@example.com' })] });
      rejectRead();
      expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
      resetScratch();
      const again = createRule('alice@example.com.', 'user@gmail.com');
      // 配置点→无点：规范域仍是本域，精确形式变更；拒读、无 marker；恢复点域后可读。
      domains.delete('example.com.');
      domains.add('example.com');
      try {
        rejectRead();
        expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
      } finally {
        domains.delete('example.com');
        domains.add('example.com.');
      }
      expect(existsSync(`${storeFile()}.failclosed`)).toBe(false);
      expect(readForwardingStore().rules[0]?.address).toBe(again.address);
    } finally {
      domains.delete('example.com.');
      known.delete('alice@example.com.');
    }

    seedStore('NOT JSON');
    expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
    expect(existsSync(`${storeFile()}.failclosed`)).toBe(true);

    resetScratch();
    domains.delete('extra.test');
    try {
      seedStore({
        schemaVersion: 1,
        rules: [
          fixtureRule({ id: 'fwd_a', address: 'cara@extra.test', destination: 'cara@gmail.com' }),
          fixtureRule({ id: 'fwd_b', address: 'not-a-mailbox', destination: 'user@gmail.com' }),
        ],
      });
      expect(() => readForwardingStore()).toThrow(ForwardStoreCorruptError);
      expect(existsSync(`${storeFile()}.failclosed`)).toBe(true);
    } finally {
      domains.add('extra.test');
    }
  });

  test('A′ identity local-part aligns with createIdentity', () => {
    // 真实建身份+findIdentity；外域身份/不存在仍拒
    for (const lp of ['foo_', 'foo-', 'a..b', 'first_last']) {
      resetScratch();
      const addr = createIdentity({ localpart: lp, issueToken: false })!.identity.address;
      const created = createForwardingRule({
        address: addr,
        destination: 'user@gmail.com',
        identityExists: (a) => Boolean(findIdentity(a)),
      });
      expect(created.address).toBe(`${lp}@test.example`);
      writeForwardingStore({ schemaVersion: 1, rules: [created] });
      expect(readForwardingStore().rules[0]?.address).toBe(`${lp}@test.example`);
    }
    expect(() =>
      createForwardingRule({
        address: 'foo_@gmail.com',
        destination: 'user@outlook.com',
        identityExists: () => true,
      }),
    ).toThrow(
      new ForwardStoreError('foreign_identity', 'forwarding identity address is invalid'),
    );
    // 本域身份 identityExists=false 仍拒 identity_not_found
    expect(() =>
      createForwardingRule({
        address: 'foo_@test.example',
        destination: 'user@gmail.com',
        identityExists: () => false,
      }),
    ).toThrow(
      new ForwardStoreError('identity_not_found', 'identity not found'),
    );
  });

  test('P1: missing verification own-key rejects write and fail-closes read', () => {
    // 正控：verification:null 可读写；缺自有键或值为 undefined 才拒。
    const good = createRule('alice@test.example', 'user@gmail.com');
    expect(good.verification).toBeNull();
    const { verification: _omit, ...noKey } = good;
    expect(() =>
      writeForwardingStore({ schemaVersion: 1, rules: [noKey] } as never),
    ).toThrow(
      new ForwardStoreError('invalid_rule_fields', 'forwarding.json invalid record fields'),
    );
    rejectWrite({ schemaVersion: 1, rules: [noKey] });
    expect(getForwardingRule(good.id)?.verification).toBeNull();
    // 自有 verification:undefined 亦拒；stringify 会省键，不得落盘。
    rejectWrite({ schemaVersion: 1, rules: [{ ...good, verification: undefined }] });
    // 盘面缺键：fail-closed 拒读，marker 归 invalid_rule_fields 族。
    const { verification: _drop, ...disk } = fixtureRule();
    seedStore({ schemaVersion: 1, rules: [disk] });
    rejectRead();
    expect(existsSync(`${storeFile()}.failclosed`)).toBe(true);
    expect(readFileSync(`${storeFile()}.failclosed`, 'utf8')).toBe('invalid_rule_fields\n');
  });

  test('P1: raw write refuses corrupt/unknown original; first/valid ok', () => {
    const next = { schemaVersion: 1 as const, rules: [fixtureRule()] } as never;
    // 负控：损坏 JSON / 未知版本各自拒写、原件字节不变、对应 marker
    for (const [payload, marker] of [['NOT JSON', 'json_parse_error'], [{ schemaVersion: 99, rules: [] }, 'unsupported_schema_version']] as [unknown, string][]) {
      seedStore(payload);
      expect(() => writeForwardingStore(next)).toThrow(ForwardStoreCorruptError);
      expect(readFileSync(storeFile(), 'utf8')).toBe(typeof payload === 'string' ? payload : JSON.stringify(payload));
      expect(readFileSync(`${storeFile()}.failclosed`, 'utf8')).toBe(`${marker}\n`);
    }
    // 正控：无正本可首次新建；有效旧正本仍可 raw write
    resetScratch();
    writeForwardingStore(next);
    writeForwardingStore({ schemaVersion: 1, rules: [fixtureRule({ destination: 'keep@outlook.com' })] } as never);
    expect(readForwardingStore().rules[0]?.destination).toBe('keep@outlook.com');
  });
});
