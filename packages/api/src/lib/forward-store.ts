/** #106 A1：DATA_DIR/forwarding.json 存储层；无发送路径，级联删留给 A2。 */

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from './config.ts';
import { LOCALPART_RE } from './identities.ts'; // 身份 local-part 与 createIdentity 同源

export const FORWARD_STORE_SCHEMA_VERSION = 1;
export const FORWARD_STORE_FILE = 'forwarding.json';

/** 规则状态；A1 只持久化，不发送/不核验验证码。 */
export type ForwardingRuleState = 'pending_verification' | 'active' | 'paused' | 'disabled';

/** 有界验证元数据：仅不可逆摘要 + 过期时间，禁止明码。 */
export type ForwardingVerificationMeta = {
  digest: string;
  expiresAt: string;
};

export type ForwardingRule = {
  id: string; address: string; destination: string; state: ForwardingRuleState;
  createdAt: string; updatedAt: string; verifiedAt: string | null; verification: ForwardingVerificationMeta | null;
};

export type ForwardingStoreFile = {
  schemaVersion: typeof FORWARD_STORE_SCHEMA_VERSION;
  rules: ForwardingRule[];
};

/** 调用方证明身份存在；抛错或返回 false 均 fail-closed。 */
export type ForwardingIdentityExists = (address: string) => boolean;

const RULE_STATES = new Set<ForwardingRuleState>(['pending_verification', 'active', 'paused', 'disabled']);

const SMTP_MAILBOX_MAX_LENGTH = 254;
const SMTP_LOCAL_PART_MAX_OCTETS = 64;
const SMTP_DOMAIN_LABEL_MAX_OCTETS = 63;
const SMTP_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** 未加引号 local-part：dot-atom，拒连续点/逗号/空格/尖括号。 */
const SMTP_LOCAL_PART_PATTERN = /^(?!.*\.\.)[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const DIGEST_HEX_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** 禁止落盘的明码/密钥键（只看 key）；未知根/规则字段另走白名单。 */
const FORBIDDEN_PLAINTEXT_KEYS = new Set(['code', 'otp', 'secret', 'token', 'password', 'verificationcode']);
const STORE_KEYS = new Set(['schemaVersion', 'rules']);
const RULE_KEYS = new Set(['id', 'address', 'destination', 'state', 'createdAt', 'updatedAt', 'verifiedAt', 'verification']);
/** 根/规则只许白名单键，避免 verification_code 等漏网拼写。 */
function hasUnknownKeys(value: object, allowed: Set<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

export class ForwardStoreCorruptError extends Error {
  readonly code = 'store_corrupt';
  readonly failureKind = 'service' as const;
  constructor(message = 'forwarding store is corrupt') {
    super(message);
    this.name = 'ForwardStoreCorruptError';
  }
}

export class ForwardStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ForwardStoreError';
    this.code = code;
  }
}

let failClosed = false;

/** 测试用：写路径注入。生产代码不得设置。 */
export type ForwardingWritePhase = 'after-open' | 'chmod-tmp' | 'before-rename' | 'dir-fsync';
let writeHookForTests: ((phase: ForwardingWritePhase) => void) | undefined;

function storePath(): string {
  return join(config.dataDir, FORWARD_STORE_FILE);
}
function tmpPath(): string {
  return `${storePath()}.tmp`;
}
function failClosedPath(): string {
  return `${storePath()}.failclosed`;
}
function emptyStore(): ForwardingStoreFile {
  return { schemaVersion: FORWARD_STORE_SCHEMA_VERSION, rules: [] };
}
function persistFailed(kind: string): never {
  throw new ForwardStoreError('persist_failed', kind);
}

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    persistFailed('directory mode');
  }
}

function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) throw new Error('short_write');
    offset += n;
  }
}

/** 日志只报 kind，绝不写入目的地或验证码。 */
function markStoreFailClosed(kind: string): void {
  failClosed = true;
  try {
    writeFileSync(failClosedPath(), `${kind}\n`, { mode: 0o600 });
  } catch {
    // 内存闸仍拦住本进程
  }
  console.error(`[forward-store] HIGH: fail-closed due to ${kind}`);
}

function checkFailClosed(): void {
  if (failClosed || existsSync(failClosedPath())) {
    failClosed = true;
    throw new ForwardStoreCorruptError('forwarding store is in fail-closed state');
  }
}

function canonicalDomain(raw: string): string {
  return raw.toLowerCase().replace(/\.+$/, '');
}
function mailboxDomain(address: string): string {
  return canonicalDomain(address.slice(address.lastIndexOf('@') + 1));
}

function isInstanceDomain(domain: string): boolean {
  const needle = canonicalDomain(domain);
  for (const d of config.allDomains) {
    if (canonicalDomain(d) === needle) return true;
  }
  return false;
}

function hasForbiddenPlaintextKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenPlaintextKey(item));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PLAINTEXT_KEYS.has(key.toLowerCase()) && child != null) return true;
    if (hasForbiddenPlaintextKey(child)) return true;
  }
  return false;
}

function isValidMailbox(address: string, localPartRe = SMTP_LOCAL_PART_PATTERN): boolean {
  if (typeof address !== 'string' || CONTROL_CHAR_PATTERN.test(address)) return false;
  if (address.length > SMTP_MAILBOX_MAX_LENGTH || address.includes(' ')) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at !== address.indexOf('@')) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain) return false;
  if (Buffer.byteLength(local, 'utf8') > SMTP_LOCAL_PART_MAX_OCTETS) return false;
  if (!localPartRe.test(local)) return false; // 缺省严 SMTP；身份调用方传入 LOCALPART_RE
  // 多尾点非法；单尾点按 DNS 绝对域名兼容，本域目的仍由 isInstanceDomain 拒绝。
  if (domain.endsWith('..')) return false;
  const labels = domain.replace(/\.$/, '').split('.');
  if (labels.length < 2) return false;
  return labels.every((label) =>
    label.length > 0 && Buffer.byteLength(label, 'utf8') <= SMTP_DOMAIN_LABEL_MAX_OCTETS && SMTP_DOMAIN_LABEL_PATTERN.test(label),
  );
}

/** 只小写域名，保留 SMTP local-part 大小写（对齐 smtp-envelope）。 */
function normalizeDestination(destination: string): string {
  const trimmed = destination.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed.toLowerCase();
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

function assertDestinationShape(destination: string): string {
  const dest = normalizeDestination(destination);
  if (!isValidMailbox(dest) || CONTROL_CHAR_PATTERN.test(destination)) {
    throw new ForwardStoreError('invalid_destination', 'forwarding destination is invalid');
  }
  return dest;
}

function assertDestination(destination: string): string {
  const dest = assertDestinationShape(destination);
  if (isInstanceDomain(mailboxDomain(dest))) {
    throw new ForwardStoreError('instance_destination', 'forwarding destination is invalid');
  }
  return dest;
}

function assertIdentityShape(address: string): string {
  // 静态只验单尾点语法与 trim/小写规范形；身份 local-part 用 LOCALPART_RE。
  const addr = address.trim().toLowerCase();
  if (!isValidMailbox(addr, LOCALPART_RE) || CONTROL_CHAR_PATTERN.test(address)) {
    throw new ForwardStoreError('invalid_address', 'forwarding identity address is invalid');
  }
  return addr;
}

function assertIdentityAddress(address: string): string {
  const addr = assertIdentityShape(address);
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  if (!config.allDomains.has(domain)) {
    throw new ForwardStoreError('foreign_identity', 'forwarding identity address is invalid');
  }
  return addr;
}

/** 点/无点身份共用规范重复键（去尾点），与配置无关。 */
function identityKey(address: string): string {
  return `${address.slice(0, address.lastIndexOf('@'))}@${mailboxDomain(address)}`;
}

function assertVerification(
  value: ForwardingVerificationMeta | null | undefined,
): ForwardingVerificationMeta | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ForwardStoreError('invalid_verification', 'verification metadata rejected');
  }
  // 只许 digest/expiresAt；额外键（含 verification_code）拒读写，错误不带回显。
  for (const key of Object.keys(value)) {
    if (key !== 'digest' && key !== 'expiresAt') {
      throw new ForwardStoreError('invalid_verification', 'verification metadata rejected');
    }
  }
  if (hasForbiddenPlaintextKey(value)) {
    throw new ForwardStoreError('plaintext_forbidden', 'verification metadata rejected');
  }
  if (typeof value.digest !== 'string' || !DIGEST_HEX_PATTERN.test(value.digest) ||
      typeof value.expiresAt !== 'string' || !ISO_TIME_PATTERN.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new ForwardStoreError('invalid_verification', 'verification metadata rejected');
  }
  return { digest: value.digest, expiresAt: value.expiresAt };
}

function assertVerifiedAt(value: string | null): void {
  if (value === null) return;
  if (!ISO_TIME_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ForwardStoreError('invalid_verified_at', 'verifiedAt rejected');
  }
}

/** 与读盘同等字段形态；未知 state / 无效 id / 缺 verification 自有键或值为 undefined 写前拒绝。 */
function assertRuleFields(rule: unknown): asserts rule is ForwardingRule {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new ForwardStoreError('invalid_rule_fields', 'forwarding.json invalid record fields');
  }
  const r = rule as Record<string, unknown>;
  if (hasUnknownKeys(r, RULE_KEYS) || typeof r.id !== 'string' || !r.id.startsWith('fwd_') ||
      typeof r.address !== 'string' || typeof r.destination !== 'string' || typeof r.state !== 'string' ||
      !RULE_STATES.has(r.state as ForwardingRuleState) || typeof r.createdAt !== 'string' ||
      typeof r.updatedAt !== 'string' || (r.verifiedAt !== null && typeof r.verifiedAt !== 'string') ||
      // verification 须为自有键；值可为 null，缺键或 undefined 不可接受
      !Object.hasOwn(r, 'verification') || r.verification === undefined) {
    throw new ForwardStoreError('invalid_rule_fields', 'forwarding.json invalid record fields');
  }
}

function assertStoreStructure(rules: ForwardingRule[]): void {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const rule of rules) {
    const address = assertIdentityShape(rule.address);
    const dest = assertDestinationShape(rule.destination);
    if (rule.address !== address || rule.destination !== dest) {
      throw new ForwardStoreError(
        rule.address !== address ? 'invalid_address' : 'invalid_destination',
        rule.address !== address ? 'forwarding identity address is invalid' : 'forwarding destination is invalid',
      );
    }
    assertVerification(rule.verification);
    assertVerifiedAt(rule.verifiedAt);
    if (rule.state === 'active' && !rule.verifiedAt) {
      throw new ForwardStoreError('unverified_active', 'active rule requires verifiedAt');
    }
    const key = identityKey(address);
    if (ids.has(rule.id) || addresses.has(key)) {
      throw new ForwardStoreError('duplicate_rule', 'forwarding rule already exists');
    }
    ids.add(rule.id);
    addresses.add(key);
  }
}

function assertStoreDomainPolicy(rules: ForwardingRule[]): void {
  for (const rule of rules) {
    const domain = rule.address.slice(rule.address.lastIndexOf('@') + 1);
    // 身份域须原样在 allDomains；点/无点互换属策略，拒读不写 marker。
    if (!config.allDomains.has(domain)) {
      throw new ForwardStoreError('foreign_identity', 'forwarding identity address is invalid');
    }
    if (isInstanceDomain(mailboxDomain(rule.destination))) {
      throw new ForwardStoreError('instance_destination', 'forwarding destination is invalid');
    }
  }
}
function assertStoreInvariants(rules: ForwardingRule[]): void {
  assertStoreStructure(rules);
  assertStoreDomainPolicy(rules);
}

function parseFile(content: string): ForwardingStoreFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    markStoreFailClosed('json_parse_error');
    throw new ForwardStoreCorruptError('forwarding.json is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    markStoreFailClosed('root_not_object');
    throw new ForwardStoreCorruptError('forwarding.json root must be an object');
  }

  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== FORWARD_STORE_SCHEMA_VERSION) {
    markStoreFailClosed('unsupported_schema_version');
    throw new ForwardStoreCorruptError('forwarding.json unsupported schemaVersion');
  }
  if (!Array.isArray(root.rules)) {
    markStoreFailClosed('rules_not_array');
    throw new ForwardStoreCorruptError('forwarding.json rules must be an array');
  }
  if (hasUnknownKeys(root, STORE_KEYS)) {
    markStoreFailClosed('unknown_root_field');
    throw new ForwardStoreCorruptError('forwarding.json rejected unknown field');
  }
  if (hasForbiddenPlaintextKey(root)) {
    markStoreFailClosed('plaintext_key');
    throw new ForwardStoreCorruptError('forwarding.json rejected plaintext key');
  }

  for (const item of root.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      markStoreFailClosed('invalid_rule_item');
      throw new ForwardStoreCorruptError('forwarding.json item is not an object');
    }
    try {
      assertRuleFields(item);
    } catch {
      markStoreFailClosed('invalid_rule_fields');
      throw new ForwardStoreCorruptError('forwarding.json invalid record fields');
    }
    try {
      assertVerification((item as ForwardingRule).verification as ForwardingVerificationMeta | null | undefined);
    } catch {
      markStoreFailClosed('invalid_verification');
      throw new ForwardStoreCorruptError('forwarding.json invalid verification');
    }
  }

  // 先全表静态结构，再本域策略；仅策略冲突不写永久 marker。
  try {
    assertStoreStructure(root.rules as ForwardingRule[]);
  } catch {
    markStoreFailClosed('invariant_violation');
    throw new ForwardStoreCorruptError('forwarding.json invariant violation');
  }
  try {
    assertStoreDomainPolicy(root.rules as ForwardingRule[]);
  } catch (err) {
    const code = err instanceof ForwardStoreError ? err.code : '';
    console.error(`[forward-store] HIGH: fail-closed due to ${code || 'policy_conflict'}`);
    throw new ForwardStoreCorruptError('forwarding store rejected by current domain policy');
  }

  return root as ForwardingStoreFile;
}

export function readForwardingStore(): ForwardingStoreFile {
  checkFailClosed();
  ensureDataDir();
  const file = storePath();
  if (!existsSync(file)) return emptyStore();

  const text = readFileSync(file, 'utf8');
  if (!text.trim()) {
    markStoreFailClosed('empty_file');
    throw new ForwardStoreCorruptError('forwarding.json exists but is empty');
  }
  return parseFile(text);
}

export function writeForwardingStore(data: ForwardingStoreFile): void {
  checkFailClosed();
  ensureDataDir();
  if (data.schemaVersion !== FORWARD_STORE_SCHEMA_VERSION) {
    throw new ForwardStoreError('unsupported_schema_version', 'unsupported schemaVersion');
  }
  if (hasUnknownKeys(data, STORE_KEYS)) {
    throw new ForwardStoreError('invalid_store_fields', 'forwarding.json invalid record fields');
  }
  if (hasForbiddenPlaintextKey(data)) {
    throw new ForwardStoreError('plaintext_forbidden', 'verification metadata rejected');
  }
  for (const rule of data.rules) {
    assertRuleFields(rule);
  }
  assertStoreInvariants(data.rules);

  const tmp = tmpPath();
  const target = storePath();
  const text = JSON.stringify(data, null, 2);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeHookForTests?.('after-open');
    writeAllSync(fd, text);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 残留不覆盖正式文件
    }
    throw err;
  }
  closeSync(fd);

  try {
    writeHookForTests?.('chmod-tmp');
    chmodSync(tmp, 0o600);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // 未 rename，正本不变
    }
    persistFailed('file mode');
  }

  try {
    writeHookForTests?.('before-rename');
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 中途失败不得改正式文件
    }
    throw err;
  }

  renameSync(tmp, target);

  try {
    writeHookForTests?.('dir-fsync');
    const dirFd = openSync(config.dataDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    markStoreFailClosed('dir_fsync');
    persistFailed('directory fsync');
  }
}

/** 域隔离摘要：绑定主域+身份；禁止 SMTP_PASS 回退钥。 */
export function digestForwardingVerificationCode(address: string, code: string): string {
  if (typeof code !== 'string' || code.length === 0 || CONTROL_CHAR_PATTERN.test(code)) {
    throw new ForwardStoreError('invalid_code', 'verification code rejected');
  }
  const addr = assertIdentityAddress(address);
  const secret = config.taskSigningSecretExplicit;
  if (!secret || secret.length < 32) {
    throw new ForwardStoreError('signing_secret_required', 'explicit signing secret required');
  }
  return createHmac('sha256', secret)
    .update(`forward-verify-v1\0${config.domain}\0${addr}\0${code}`)
    .digest('hex');
}

export function listForwardingRules(address?: string): ForwardingRule[] {
  const file = readForwardingStore();
  if (!address) return file.rules;
  const needle = address.toLowerCase();
  return file.rules.filter((r) => r.address === needle);
}
export function getForwardingRule(id: string): ForwardingRule | undefined {
  return readForwardingStore().rules.find((r) => r.id === id);
}
export function getForwardingRuleByAddress(address: string): ForwardingRule | undefined {
  const needle = address.toLowerCase();
  return readForwardingStore().rules.find((r) => r.address === needle);
}

export function createForwardingRule(params: {
  address: string;
  destination: string;
  identityExists: ForwardingIdentityExists;
  verification?: ForwardingVerificationMeta | null;
}): ForwardingRule {
  const address = assertIdentityAddress(params.address);
  const destination = assertDestination(params.destination);

  let exists = false;
  try {
    exists = params.identityExists(address);
  } catch {
    throw new ForwardStoreError('identity_lookup_failed', 'identity lookup failed');
  }
  if (!exists) {
    throw new ForwardStoreError('identity_not_found', 'identity not found');
  }

  const file = readForwardingStore();
  if (file.rules.some((r) => identityKey(r.address) === identityKey(address))) {
    throw new ForwardStoreError('duplicate_rule', 'forwarding rule already exists');
  }

  const now = new Date().toISOString();
  const record: ForwardingRule = {
    id: `fwd_${randomUUID()}`, address, destination, state: 'pending_verification',
    createdAt: now, updatedAt: now, verifiedAt: null, verification: assertVerification(params.verification),
  };
  file.rules.push(record);
  writeForwardingStore(file);
  return record;
}

export function updateForwardingRule(
  id: string,
  patch: {
    state?: ForwardingRuleState;
    verifiedAt?: string | null;
    verification?: ForwardingVerificationMeta | null;
  },
): ForwardingRule {
  const file = readForwardingStore();
  const idx = file.rules.findIndex((r) => r.id === id);
  if (idx < 0) throw new ForwardStoreError('not_found', 'forwarding rule not found');
  const current = file.rules[idx]!;
  if (patch.state !== undefined && !RULE_STATES.has(patch.state)) {
    throw new ForwardStoreError('invalid_state', 'forwarding state rejected');
  }
  file.rules[idx] = {
    ...current, state: patch.state ?? current.state,
    verifiedAt: patch.verifiedAt !== undefined ? patch.verifiedAt : current.verifiedAt,
    verification: patch.verification !== undefined ? assertVerification(patch.verification) : current.verification,
    updatedAt: new Date().toISOString(),
  };
  writeForwardingStore(file);
  return file.rules[idx]!;
}

export function deleteForwardingRule(id: string): ForwardingRule | undefined {
  const file = readForwardingStore();
  const idx = file.rules.findIndex((r) => r.id === id);
  if (idx < 0) return undefined;
  const [removed] = file.rules.splice(idx, 1);
  writeForwardingStore(file);
  return removed;
}

/** A2 级联：先撤规则；存储损坏 fail-closed，不得继续删身份。 */
export function deleteForwardingRulesForAddress(address: string): ForwardingRule[] {
  const needle = address.toLowerCase();
  const file = readForwardingStore();
  const removed = file.rules.filter((r) => r.address === needle);
  if (removed.length === 0) return [];
  file.rules = file.rules.filter((r) => r.address !== needle);
  writeForwardingStore(file);
  return removed;
}

/** 非 bun test 拒绝；DATA_DIR 必须是 tmpdir 下 scratch 子目录，禁止等于 tmp 根。 */
function assertTestOnlyHelper(): void {
  if (process.env.BUN_TEST !== '1') {
    throw new ForwardStoreError('test_helper_refused', 'test helper refused');
  }
  const dir = resolve(config.dataDir);
  const tmp = resolve(tmpdir());
  if (dir === tmp || !dir.startsWith(`${tmp}/`)) {
    throw new ForwardStoreError('test_helper_refused', 'test helper refused');
  }
}

export function resetForwardingStoreForTests(): void {
  assertTestOnlyHelper();
  failClosed = false;
  writeHookForTests = undefined;
  for (const p of [failClosedPath(), tmpPath(), storePath()]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
export function setForwardingFailClosedForTests(value: boolean): void {
  assertTestOnlyHelper();
  failClosed = value;
}
export function setForwardingWriteHookForTests(
  hook: ((phase: ForwardingWritePhase) => void) | undefined,
): void {
  assertTestOnlyHelper();
  writeHookForTests = hook;
}
