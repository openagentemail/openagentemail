/**
 * Identity store. Identities are logical addresses (localpart@DOMAIN) that
 * all land in the single catch-all mailbox; the api matches messages to
 * identities by the To/Delivered-To header at read time.
 *
 * Each identity carries a scoped API token (stored as a SHA-256 hash; the
 * plaintext is shown exactly once at creation/rotation). An identity token
 * may only read mail for, and send from, its own address — day-to-day agent
 * usage should use identity tokens and keep the admin API_KEYS offline.
 *
 * Persisted as a JSON file under DATA_DIR — simple and durable enough for
 * v0.x; swap for sqlite if identity volume ever matters.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import {
  MAX_SCOPE_LENGTH,
  MAX_SCOPES_COUNT,
  isSupportedScope,
  isDelegationScope,
} from './identity-scopes.ts';
import { revokeGrantsForAddress } from './oauth-store.ts';
import {
  revokeDelegationsForAddress,
  revokeDelegationsOnGranteeTokenRotate,
} from './delegations.ts';
import { cascadeDeleteWebhooksForAddress } from './webhook-store.ts';
import { recordAuditEvent } from './audit.ts';

export type WebhookCancelCallback = (webhookId: string, reason: string) => void;
let webhookCancelCallback: WebhookCancelCallback | undefined;

export function registerWebhookCancelCallback(cb: WebhookCancelCallback): void {
  webhookCancelCallback = cb;
}

/**
 * deleteIdentity → ntfy 路由级联（#249-⑦）：回调注入，避免 identities↔notify 循环依赖。
 * 与 registerWebhookCancelCallback 同款；由 notify.ts 模块加载时注册。
 */
export type NotifyRouteDeleteCallback = (address: string, actor?: string) => void;
let notifyRouteDeleteCallback: NotifyRouteDeleteCallback | undefined;

export function registerNotifyRouteDeleteCallback(cb: NotifyRouteDeleteCallback): void {
  notifyRouteDeleteCallback = cb;
}

/** Mail-arrival push content detail. 1 = interrupt only (default), 2 = +subject/from, 3 = +body preview/OTP. */
export type PushContentTier = 1 | 2 | 3;

export const DEFAULT_PUSH_CONTENT_TIER: PushContentTier = 1;

/** Shown when tier 3 is set or returned; body/OTP leave the server via ntfy. */
export const PUSH_TIER3_WARNING =
  'Tier 3 includes message body previews and OTP codes/links in push notifications. That content leaves this server for the ntfy channel.';

// 叶子常量再导出，服务端既有 import 面保持不变。
export {
  MAX_SCOPE_LENGTH,
  MAX_SCOPES_COUNT,
  SUPPORTED_SCOPES,
  SUPPORTED_SCOPES_SET,
  isSupportedScope,
  DELEGATION_SCOPES,
  DELEGATION_SCOPES_SET,
  isDelegationScope,
} from './identity-scopes.ts';
export type { SupportedScope, DelegationScope } from './identity-scopes.ts';

export type ScopeValidationResult =
  | { ok: true; scopes: string[] }
  | { ok: false; error: string; details?: unknown };

/**
 * Validate scopes input on identity creation and token rotation.
 * Enforces string array type, bounded count and item lengths, duplicate rejection,
 * and known supported scope check.
 */
export function validateScopesInput(scopes: unknown): ScopeValidationResult {
  if (!Array.isArray(scopes)) {
    return { ok: false, error: 'invalid_request', details: 'scopes must be an array of strings' };
  }
  if (scopes.length > MAX_SCOPES_COUNT) {
    return { ok: false, error: 'invalid_request', details: 'too_many_scopes' };
  }
  const seen = new Set<string>();
  for (const item of scopes) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_SCOPE_LENGTH) {
      return { ok: false, error: 'invalid_request', details: 'invalid_scope_format' };
    }
    if (seen.has(item)) {
      return { ok: false, error: 'invalid_request', details: 'duplicate_scope' };
    }
    seen.add(item);
    if (!isSupportedScope(item)) {
      return { ok: false, error: 'unsupported_scope', details: `Unsupported scope: ${item}` };
    }
  }
  return { ok: true, scopes: [...scopes] };
}

/**
 * Delegation 专用 scopes 校验（#275 R1 F4）：仅允许 DELEGATION_SCOPES。
 * 错误形态与 validateScopesInput 对齐（unsupported_scope + details）。
 */
export function validateDelegationScopesInput(scopes: unknown): ScopeValidationResult {
  if (!Array.isArray(scopes)) {
    return { ok: false, error: 'invalid_request', details: 'scopes must be an array of strings' };
  }
  if (scopes.length > MAX_SCOPES_COUNT) {
    return { ok: false, error: 'invalid_request', details: 'too_many_scopes' };
  }
  const seen = new Set<string>();
  for (const item of scopes) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_SCOPE_LENGTH) {
      return { ok: false, error: 'invalid_request', details: 'invalid_scope_format' };
    }
    if (seen.has(item)) {
      return { ok: false, error: 'invalid_request', details: 'duplicate_scope' };
    }
    seen.add(item);
    if (!isDelegationScope(item)) {
      return { ok: false, error: 'unsupported_scope', details: `Unsupported scope: ${item}` };
    }
  }
  return { ok: true, scopes: [...scopes] };
}

/** 每父身份允许的存量子身份上限（#275；父不能删子 → 硬封顶）。 */
export const MAX_CHILD_IDENTITIES = 50;

/** 非 admin 可授给子身份的 scope 白名单（叠加在「子⊆父」之上；禁 identities:create）。 */
export const CHILD_GRANTABLE_SCOPES = ['read:messages', 'messages:send'] as const;
export const CHILD_GRANTABLE_SCOPES_SET = new Set<string>(CHILD_GRANTABLE_SCOPES);

export interface Identity {
  address: string;
  name?: string;
  createdAt: string;
  /** Explicit root-level permission to notify the human-alert topics. */
  canNotifyUser?: boolean;
  /**
   * How much content mail-arrival user pushes include for this identity.
   * Absent means tier 1 (interrupt only) for backward compatibility.
   */
  pushContentTier?: PushContentTier;
  /** SHA-256 hex of the identity's API token. Absent on pre-token stores. */
  tokenHash?: string;
  /**
   * Optional token scopes.
   * When undefined/absent, the token has legacy unscoped/full identity permissions.
   * When present (including empty array []), privileges are subtractively restricted.
   */
  scopes?: string[];
  /**
   * 父身份地址（小写）。仅非 admin 的 scoped create 写入；admin create 不写。
   * 归属不可转移/重指；悬空（父已删）时判定永假。
   */
  parentIdentity?: string;
}

export function resolvePushContentTier(identity: Pick<Identity, 'pushContentTier'>): PushContentTier {
  const tier = identity.pushContentTier;
  return tier === 2 || tier === 3 ? tier : DEFAULT_PUSH_CONTENT_TIER;
}

function isPushContentTier(value: unknown): value is PushContentTier {
  return value === 1 || value === 2 || value === 3;
}

const WORDS = [
  'fox', 'owl', 'bear', 'wolf', 'hawk', 'lynx', 'otter', 'raven', 'moose', 'falcon',
  'badger', 'heron', 'puma', 'bison', 'crane', 'viper', 'gecko', 'orca', 'ibex', 'wren',
];
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const LOCALPART_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function storePath(): string {
  return join(config.dataDir, 'identities.json');
}

/**
 * Structural identity check. `pushContentTier` is intentionally *not*
 * validated here: an unknown enum value is a compatibility case (normalize
 * to default tier 1), not store corruption that should take every identity
 * offline.
 */
function isIdentityShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.address === 'string' &&
    typeof identity.createdAt === 'string' &&
    (identity.name === undefined || typeof identity.name === 'string') &&
    (identity.canNotifyUser === undefined || typeof identity.canNotifyUser === 'boolean') &&
    (identity.tokenHash === undefined || typeof identity.tokenHash === 'string') &&
    (identity.scopes === undefined ||
      (Array.isArray(identity.scopes) && identity.scopes.every((s) => typeof s === 'string'))) &&
    // #275：可选父地址；缺省=旧数据；类型错才拒（F94 宽容）
    (identity.parentIdentity === undefined || typeof identity.parentIdentity === 'string')
  );
}

/**
 * Coerce a structurally valid store record into an Identity for in-memory use.
 *
 * Spread the raw record so unknown per-identity fields (and future
 * `pushContentTier` enum values written by a newer binary) survive store
 * rewrites on this older binary (F94). Downgrade→upgrade must not permanently
 * strip forward-compatible data.
 *
 * Read safety: `resolvePushContentTier` maps anything other than 2/3 to the
 * default tier 1, and all consumers go through resolve or `=== 2` / `=== 3`
 * checks — an old binary never discloses more than tier 1 for a future tier
 * value. Explicit API tier updates still overwrite `pushContentTier` with a
 * known 1|2|3 value.
 */
function coerceIdentity(raw: Record<string, unknown>): Identity {
  return {
    ...raw,
    address: raw.address as string,
    createdAt: raw.createdAt as string,
  } as Identity;
}

/**
 * Identity-store parse cache keyed by a composite file-version signal (one
 * statSync): dev, ino, mtimeMs, ctimeMs, size. Cross-process writers are
 * detected without relying on mtime alone:
 * - atomic replace (tmp + rename) → ino (and usually mtime) changes;
 * - in-place rewrite with preserved mtime → ctimeMs and/or size change;
 * - if ino is 0/unstable on a filesystem, keys may thrash (extra re-reads)
 *   but correctness is preserved — never serve stale identities/tokens.
 * In-process writers call invalidateStoreCache() before writing so same-tick
 * rewrites stay visible without waiting on stat.
 */
type StoreFileVersion = {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

/** Sentinel version for a missing store file (mtimeMs === -1). */
const MISSING_STORE_VERSION: StoreFileVersion = {
  dev: 0,
  ino: 0,
  mtimeMs: -1,
  ctimeMs: -1,
  size: -1,
};

type StoreCache = {
  version: StoreFileVersion;
  identities: Identity[];
  byAddress: Map<string, Identity>;
};

let storeCache: StoreCache | undefined;

function invalidateStoreCache(): void {
  storeCache = undefined;
}

function fileVersionFromStat(st: {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}): StoreFileVersion {
  return {
    dev: st.dev,
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
  };
}

function storeVersionsEqual(a: StoreFileVersion, b: StoreFileVersion): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size
  );
}

function buildAddressIndex(identities: Identity[]): Map<string, Identity> {
  const byAddress = new Map<string, Identity>();
  for (const identity of identities) {
    byAddress.set(identity.address.toLowerCase(), identity);
  }
  return byAddress;
}

function load(): Identity[] {
  const path = storePath();
  if (!existsSync(path)) {
    // Sentinel so a later create is detected (file appears with a real version).
    if (storeCache && storeVersionsEqual(storeCache.version, MISSING_STORE_VERSION)) {
      return storeCache.identities;
    }
    storeCache = {
      version: MISSING_STORE_VERSION,
      identities: [],
      byAddress: new Map(),
    };
    return storeCache.identities;
  }
  try {
    const version = fileVersionFromStat(statSync(path));
    if (storeCache && storeVersionsEqual(storeCache.version, version)) {
      return storeCache.identities;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isIdentityShape)) {
      throw new Error('invalid identity store shape');
    }
    const identities = parsed.map((entry) => coerceIdentity(entry as Record<string, unknown>));
    storeCache = {
      version,
      identities,
      byAddress: buildAddressIndex(identities),
    };
    return storeCache.identities;
  } catch (err) {
    invalidateStoreCache();
    if ((err as Error).message === 'identity_store_corrupt') throw err;
    // Fail closed. Treating a damaged store as empty looks harmless until the
    // next create/rotate saves over it: every existing identity and token is
    // gone. The message carries no file content on purpose.
    //
    // Threat modeling & evaluation note (Issue #130 Item 6):
    // 1. Read amplification: Dropping the cache on error means subsequent reads
    //    re-attempt statSync/readFileSync against the corrupt file. This is
    //    intentional and bounded: as soon as operators repair or restore the file,
    //    the service self-heals on the very next read without requiring process restart.
    // 2. 401 vs 500 split: Non-OAuth tokens (oa_ identity tokens or invalid tokens)
    //    surface 500 via rethrow, while recognizable OAuth tokens fail-closed as 401.
    //    While this response code difference is theoretically a membership oracle,
    //    the 256-bit entropy of tokens makes enumeration impossible, and corruption
    //    cannot be remotely induced (single writer with atomic rename and 0600 mode).
    throw new Error('identity_store_corrupt');
  }
}

/**
 * Persist the identity store. DATA_DIR is designed for a **single writer**
 * process (the Compose/API-only stacks run one API). `save` uses tmp+rename
 * so one process never tears the JSON file, but concurrent writers across
 * multiple processes sharing the same DATA_DIR are **unsupported** — last
 * writer wins without CAS/file locking (F78: document only; no multi-process
 * storage rewrite in this product).
 */
function save(identities: Identity[]): void {
  // Drop the cache *before* any write attempt. Callers mutate the array/objects
  // returned by load() then call save(); if we only invalidated after rename,
  // a failed write (disk full, read-only volume) would leave those unpersisted
  // mutations in cache and diverge memory from disk until restart. Invalidate
  // first: success → next load re-reads the new file; failure → next load
  // re-reads the old file. Same-ms in-process rewrites stay visible either way.
  invalidateStoreCache();
  // The store holds every identity's token hash — keep it to the owner.
  // chmod explicitly in both places: mkdirSync's mode does nothing when the
  // directory already exists, and writeFileSync's mode is masked by umask
  // and ignored altogether when the temp file already exists.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // A bind mount may be owned by another uid; the file mode below still
    // applies, so this is best effort rather than fatal.
  }
  const path = storePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(identities, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function randomLocalpart(): string {
  const word = WORDS[randomInt(WORDS.length)];
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return `${word}-${suffix}`;
}

export function listIdentities(): Identity[] {
  return load().map(({ tokenHash: _tokenHash, ...rest }) => rest);
}

export function findIdentity(address: string): Identity | undefined {
  load();
  return storeCache?.byAddress.get(address.toLowerCase());
}

/** Generate a new scoped token. Plaintext is returned once; only its hash persists. */
function generateToken(): { token: string; tokenHash: string } {
  const token = `oa_${randomBytes(24).toString('base64url')}`;
  return { token, tokenHash: hashToken(token) };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time-ish hash comparison. */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Resolve an identity by its plaintext API token; undefined if no match. */
export function findIdentityByToken(token: string): Identity | undefined {
  const hash = hashToken(token);
  return findIdentityByTokenHash(hash);
}

/**
 * 按已计算的 SHA-256 hex 反查身份。
 * 供 UI session 持久化后 authenticate：落盘只存 tokenHash，不再持有明文。
 */
export function findIdentityByTokenHash(tokenHash: string): Identity | undefined {
  return load().find((i) => i.tokenHash && hashEquals(i.tokenHash, tokenHash));
}

/** Returns the created identity plus its one-time plaintext token, or null if taken. */
export function createIdentity(input: {
  name?: string;
  localpart?: string;
  domain?: string;
  canNotifyUser?: boolean;
  /**
   * 默认 true。同意页新建身份传 false：不发 oa_ 票，避免幽灵 token 落库。
   * 此时返回的 token 为空串。
   */
  issueToken?: boolean;
  /** Optional token scopes; undefined means full-power identity token. */
  scopes?: string[];
  /**
   * 父身份地址（小写）。仅非 admin scoped create 传入；空串/缺省不写字段。
   */
  parentIdentity?: string;
}): { identity: Identity; token: string } | null {
  const identities = load();
  const targetDomain = (input.domain ?? config.domain).toLowerCase().trim();
  if (targetDomain.length > 253 || !config.allDomains.has(targetDomain)) {
    throw new Error('invalid_domain');
  }

  let localpart = input.localpart?.toLowerCase();
  if (localpart) {
    if (!LOCALPART_RE.test(localpart)) {
      throw new Error('invalid_localpart');
    }
  } else {
    // Retry a few times on the off chance of a random collision.
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = randomLocalpart();
      if (!identities.some((i) => i.address.split('@')[0].toLowerCase() === candidate)) {
        localpart = candidate;
        break;
      }
    }
    if (!localpart) throw new Error('localpart_collision');
  }

  const address = `${localpart}@${targetDomain}`;
  // 同址幂等：已存在则返回 null（路由层映射为 address_exists）。
  if (identities.some((i) => i.address === address)) return null;

  // #275 R3 F12b：地址空闲时清理仍指向该址的悬空归属（F2 前存量自愈），与新身份同一次 save
  let orphaned = 0;
  const cleaned = identities.map((entry) => {
    if (entry.parentIdentity === address) {
      orphaned++;
      const { parentIdentity: _removed, ...rest } = entry;
      return rest as Identity;
    }
    return entry;
  });

  const issueToken = input.issueToken !== false;
  let token = '';
  let tokenHash: string | undefined;
  if (issueToken) {
    const generated = generateToken();
    token = generated.token;
    tokenHash = generated.tokenHash;
  }
  // 父地址仅非空时落库（admin 路径不传 → 字段缺省）
  const parent = input.parentIdentity?.toLowerCase().trim();
  const identity: Identity = {
    address,
    ...(input.name ? { name: input.name } : {}),
    ...(input.canNotifyUser ? { canNotifyUser: true } : {}),
    createdAt: new Date().toISOString(),
    ...(tokenHash ? { tokenHash } : {}),
    ...(input.scopes !== undefined ? { scopes: [...input.scopes] } : {}),
    ...(parent ? { parentIdentity: parent } : {}),
  };
  cleaned.push(identity);
  save(cleaned);
  if (orphaned > 0) {
    recordAuditEvent({
      event: 'identity.parent_orphaned',
      address,
      outcome: 'ok',
    });
  }
  return { identity, token };
}

/**
 * 统计某父身份下的存量子身份数（parentIdentity === parent，大小写不敏感）。
 */
export function countChildren(parent: string): number {
  const needle = parent.toLowerCase();
  return load().filter((i) => i.parentIdentity === needle).length;
}

/**
 * 判定 child 是否归属 parent（child.parentIdentity === parent）。
 * 父/子任一不存在或无归属字段 → false（悬空归属永假）。
 */
export function isParentOf(parent: string, child: string): boolean {
  const childIdentity = findIdentity(child);
  if (!childIdentity?.parentIdentity) return false;
  return childIdentity.parentIdentity === parent.toLowerCase();
}

/** #275 R4 F15：rotate 原子结果（成功 / 可映射失败） */
export type RotateIdentityTokenResult =
  | {
      ok: true;
      token: string;
      prevScopes?: string[];
      scopes?: string[];
      identity: Identity;
    }
  | { ok: false; error: 'not_found'; status: 404 }
  | {
      ok: false;
      error: 'child_parent_missing';
      status: 400;
      details: 'child identity has no existing parent identity';
    }
  | {
      ok: false;
      error: 'child_scope_invalid';
      status: 400 | 403;
      body: { error: string; details?: unknown };
    };

/**
 * 子身份 rotate 的 store 层约束（#275 R4 F15；覆盖 REST 空 body / UI 直调）。
 * scopes === undefined → 仅查父存在；显式 null/数组 → 拒 unscoped + 白名单 + 子⊆父。
 */
function enforceChildRotateConstraints(
  identity: Identity,
  identities: Identity[],
  scopes: string[] | null | undefined,
): Extract<RotateIdentityTokenResult, { ok: false }> | null {
  if (!identity.parentIdentity) return null;
  const parent = identities.find((i) => i.address === identity.parentIdentity);
  if (!parent) {
    return {
      ok: false,
      error: 'child_parent_missing',
      status: 400,
      details: 'child identity has no existing parent identity',
    };
  }
  // 保留现有 scopes：不重校验 stale；仅保证父仍在
  if (scopes === undefined) return null;
  if (scopes === null) {
    return {
      ok: false,
      error: 'child_scope_invalid',
      status: 400,
      body: {
        error: 'invalid_request',
        details: 'child identity cannot be reset to an unscoped token',
      },
    };
  }
  if (scopes.includes('identities:create')) {
    return {
      ok: false,
      error: 'child_scope_invalid',
      status: 400,
      body: {
        error: 'invalid_request',
        details: 'identities:create cannot be granted to child identities',
      },
    };
  }
  const validated = validateScopesInput(scopes);
  if (!validated.ok) {
    return {
      ok: false,
      error: 'child_scope_invalid',
      status: 400,
      body: { error: validated.error, details: validated.details },
    };
  }
  for (const scope of validated.scopes) {
    if (!CHILD_GRANTABLE_SCOPES_SET.has(scope)) {
      return {
        ok: false,
        error: 'child_scope_invalid',
        status: 400,
        body: {
          error: 'invalid_request',
          details: 'identities:create cannot be granted to child identities',
        },
      };
    }
  }
  // 父 unscoped = 全权；否则子⊆父当前 scopes
  if (parent.scopes !== undefined) {
    for (const scope of validated.scopes) {
      if (!parent.scopes.includes(scope)) {
        return {
          ok: false,
          error: 'child_scope_invalid',
          status: 403,
          body: { error: 'forbidden: scope exceeds parent permissions' },
        };
      }
    }
  }
  return null;
}

/**
 * Atomically snapshot existing scopes, rotate token, optionally update scopes,
 * and persist. Returns discriminated ok/error（#275 R4 F15 子约束为全路径最后防线）.
 *
 * All state mutation and snapshotting happen synchronously in the store layer,
 * eliminating any reliance on caller-level snapshot timing ("no intervening await").
 */
export function rotateIdentityTokenDetailed(
  address: string,
  scopes?: string[] | null,
): RotateIdentityTokenResult {
  const identities = load();
  const needle = address.toLowerCase();
  const identity = identities.find((i) => i.address === needle);
  if (!identity) return { ok: false, error: 'not_found', status: 404 };

  // 先拒后改：校验失败不得 revoke / mutate / save
  const childDenied = enforceChildRotateConstraints(identity, identities, scopes);
  if (childDenied) return childDenied;

  revokeDelegationsOnGranteeTokenRotate(needle);
  const prevScopes = identity.scopes !== undefined ? [...identity.scopes] : undefined;
  const { token, tokenHash } = generateToken();
  identity.tokenHash = tokenHash;
  if (scopes !== undefined) {
    if (scopes === null) delete identity.scopes;
    else identity.scopes = [...scopes];
  }
  save(identities);
  return {
    ok: true,
    token,
    prevScopes,
    scopes: identity.scopes !== undefined ? [...identity.scopes] : undefined,
    identity: { ...identity },
  };
}

/**
 * Replace an identity's token (the old one stops working immediately).
 * If `scopes` is provided (including empty array), the rotated token is scoped.
 * If `scopes` is omitted/undefined, existing scope restrictions are preserved.
 * Pass null only for an explicit reset to a legacy unscoped/full token.
 * Returns the new plaintext token, or null if not_found / 子约束拒（null 语义保持）.
 */
export function rotateIdentityToken(address: string, scopes?: string[] | null): string | null {
  const result = rotateIdentityTokenDetailed(address, scopes);
  return result.ok ? result.token : null;
}

/**
 * Remove an identity (its mail stays in the catch-all until retention
 * sweeps it). Returns false if the address didn't exist.
 * 同步级联吊销该身份下全部 OAuth grant + access/refresh 与 Delegation grants。
 * #275 R1/R3：cascades 成功后再构建孤儿副本（不 mutate 缓存对象），防 cascade 失败污染。
 */
export function deleteIdentity(address: string): boolean {
  const identities = load();
  const needle = address.toLowerCase();
  const existed = identities.some((i) => i.address === needle);
  if (!existed) return false;

  // Webhook cascade first (delete + cancel in-flight + audit). Identity save
  // after that: a failed identity write is retryable, a live subscription after
  // the identity is gone is an exfil channel (§10.5).
  // #275 R3 F14：cascades 全部成功之前不改任何 Identity 缓存对象
  const deletedWebhooks = cascadeDeleteWebhooksForAddress(needle);
  for (const wh of deletedWebhooks) {
    if (webhookCancelCallback) {
      webhookCancelCallback(wh.id, 'subscription_deleted');
    }
    recordAuditEvent({
      event: 'webhook.delete',
      outcome: 'ok',
      address: needle,
      webhookId: wh.id,
    });
  }
  // ntfy 外泄通道：先删完整地址 agents 键并落 pending_revoke，再 save 身份。
  // state 持久化失败抛错 fail-closed，身份记录必须仍在。
  // 落盘顺序窗口（与 webhook 级联同款）：notify 路由先删后，若 identity save 失败，
  // 该身份在下次 boot 前无推送路由=安全收窄方向（可重试 delete；非外泄扩大）。
  // 回调由 notify 侧 registerNotifyRouteDeleteCallback 注入（#249-⑦）。
  notifyRouteDeleteCallback?.(needle);
  revokeDelegationsForAddress(needle);
  revokeGrantsForAddress(needle);

  // cascades 成功后：构建 kept（孤儿副本，不 mutate 原对象）
  let orphaned = 0;
  const kept = identities
    .filter((i) => i.address !== needle)
    .map((i) => {
      if (i.parentIdentity !== needle) return i;
      orphaned++;
      const { parentIdentity: _removed, ...rest } = i;
      return rest as Identity;
    });
  save(kept);
  // 归属断开审计：纯标识（被删父地址）；子地址不落载荷
  if (orphaned > 0) {
    recordAuditEvent({
      event: 'identity.parent_orphaned',
      address: needle,
      outcome: 'ok',
    });
  }
  return true;
}

/**
 * Set the mail-arrival push content tier for an identity (admin-only at the
 * route layer). Returns the updated public identity fields, or null if missing.
 * Tier 1 is stored explicitly so list/read stay stable after a deliberate set.
 */
export function setIdentityPushContentTier(
  address: string,
  tier: PushContentTier,
): Identity | null {
  if (!isPushContentTier(tier)) throw new Error('invalid_push_content_tier');
  const identities = load();
  const needle = address.toLowerCase();
  const identity = identities.find((i) => i.address === needle);
  if (!identity) return null;
  identity.pushContentTier = tier;
  save(identities);
  const { tokenHash: _tokenHash, ...rest } = identity;
  return rest;
}
