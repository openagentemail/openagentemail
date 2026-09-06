// Single-writer process assumption: Like identities.json, delegations.json assumes a
// single-writer process and does not support multi-process concurrent mutations on the same DATA_DIR.
// Scope note: Currently delegations only support 'read:messages' (see SUPPORTED_SCOPES).
// If additional scopes are introduced in the future, all forbidUnlessMailboxAccess call sites must be
// audited to ensure delegations do not unintentionally grant write or admin capabilities.
//
// OAuth cascade revocation architecture note (Issue #136 Item 8):
// In the current architecture, OAuth credentials are strictly forbidden from creating or revoking
// delegation grants (enforced in routes/delegations.ts via attribution.kind === 'oauth' returning 403).
// Consequently, all active delegations are established exclusively via direct identity credentials
// or admin authority, and no OAuth-originated delegations exist in delegations.json.
// Token lifecycle & revocation semantics:
// 1. Grantee token rotation: Automatically cascades revocation of all delegations received by that
//    grantee (see revokeDelegationsOnGranteeTokenRotate in identities.ts).
// 2. Owner token rotation: Intentionally preserves delegations granted by the owner to avoid breaking
//    delegated agent access upon routine credential rotation.
// 3. Identity deletion: Bidirectionally revokes all delegations (both as owner and grantee).
// 4. Future OAuth delegation expansion: If delegations are ever allowed to be created via OAuth tokens,
//    DelegationGrant should store an optional `oauthGrantId?: string` field, and OAuth token revocation
//    or rotation must cascade-revoke any grants linked to that `oauthGrantId`.

import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { recordAuditEvent } from './audit.ts';
import { isSupportedScope } from './identities.ts';

export const DELEGATION_STORE_SCHEMA_VERSION = 1;
export const DELEGATION_STORE_FILE = 'delegations.json';

export interface DelegationGrant {
  id: string;
  mailbox: string;
  grantee: string;
  scopes: string[];
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  [key: string]: unknown;
}

export interface DelegationStoreFile {
  schemaVersion: typeof DELEGATION_STORE_SCHEMA_VERSION;
  grants: DelegationGrant[];
  [key: string]: unknown;
}

function storePath(): string {
  return join(config.dataDir, DELEGATION_STORE_FILE);
}

function isGrantShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.id === 'string' &&
    typeof g.mailbox === 'string' &&
    typeof g.grantee === 'string' &&
    Array.isArray(g.scopes) &&
    g.scopes.every((s) => typeof s === 'string') &&
    typeof g.createdAt === 'string' &&
    typeof g.createdBy === 'string' &&
    (g.revokedAt === null || typeof g.revokedAt === 'string') &&
    (g.revokedBy === null || g.revokedBy === undefined || typeof g.revokedBy === 'string')
  );
}

/**
 * 原始视图：字段规范化（小写/去空白）但**不做 scope 白名单过滤**。
 * 仅供 load() 对收窄/剔除项留痕，以及 revoke 路径对「被剔除」的 grant
 * 幂等落墓碑使用（Issue #136 R2）。
 */
function rawGrantView(raw: Record<string, unknown>): DelegationGrant {
  const rawScopes = Array.isArray(raw.scopes) ? (raw.scopes as unknown[]) : [];
  return {
    ...raw,
    id: raw.id as string,
    mailbox: (raw.mailbox as string).trim().toLowerCase(),
    grantee: (raw.grantee as string).trim().toLowerCase(),
    scopes: rawScopes.filter((s): s is string => typeof s === 'string'),
    createdAt: raw.createdAt as string,
    createdBy: raw.createdBy as string,
    revokedAt: (raw.revokedAt as string | null) ?? null,
    revokedBy: (raw.revokedBy as string | null) ?? null,
  };
}

function isDelegationStoreShape(
  value: unknown,
): value is { schemaVersion: number; grants: unknown[]; [key: string]: unknown } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.schemaVersion === DELEGATION_STORE_SCHEMA_VERSION &&
    Array.isArray(obj.grants) &&
    obj.grants.every(isGrantShape)
  );
}

type StoreFileVersion = {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

const MISSING_STORE_VERSION: StoreFileVersion = {
  dev: 0,
  ino: 0,
  mtimeMs: -1,
  ctimeMs: -1,
  size: -1,
};

type StoreCache = {
  version: StoreFileVersion;
  store: DelegationStoreFile;
  /** load 时被整条剔除（无任何支持 scope）的 grant 原始视图：留痕 + 幂等撤销用。 */
  droppedGrants: DelegationGrant[];
};

let storeCache: StoreCache | undefined;

export function invalidateDelegationStoreCache(): void {
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

function loadCache(): StoreCache {
  const path = storePath();
  if (!existsSync(path)) {
    if (storeCache && storeVersionsEqual(storeCache.version, MISSING_STORE_VERSION)) {
      return storeCache;
    }
    storeCache = {
      version: MISSING_STORE_VERSION,
      store: {
        schemaVersion: DELEGATION_STORE_SCHEMA_VERSION,
        grants: [],
      },
      droppedGrants: [],
    };
    return storeCache;
  }
  try {
    const version = fileVersionFromStat(statSync(path));
    if (storeCache && storeVersionsEqual(storeCache.version, version)) {
      return storeCache;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isDelegationStoreShape(parsed)) {
      throw new Error('invalid delegation store shape');
    }
    const grants: DelegationGrant[] = [];
    const droppedGrants: DelegationGrant[] = [];
    for (const entry of parsed.grants) {
      const view = rawGrantView(entry as Record<string, unknown>);
      const scopes = view.scopes.filter((s) => isSupportedScope(s));
      if (scopes.length === 0) {
        // Issue #136 R2：整条剔除必须留痕，不能静默吞掉磁盘上的残留。
        console.warn(
          `[delegations] grant ${view.id} (${view.mailbox} → ${view.grantee}) dropped at load: no supported scopes in ${JSON.stringify(view.scopes)}`,
        );
        droppedGrants.push(view);
        continue;
      }
      if (scopes.length < view.scopes.length) {
        console.warn(
          `[delegations] grant ${view.id} (${view.mailbox} → ${view.grantee}) scopes narrowed at load: kept ${JSON.stringify(scopes)}, dropped ${JSON.stringify(view.scopes.filter((s) => !isSupportedScope(s)))}`,
        );
      }
      grants.push({ ...view, scopes });
    }
    storeCache = {
      version,
      store: {
        ...parsed,
        schemaVersion: DELEGATION_STORE_SCHEMA_VERSION,
        grants,
      },
      droppedGrants,
    };
    return storeCache;
  } catch (err) {
    invalidateDelegationStoreCache();
    if ((err as Error).message === 'delegation_store_corrupt') throw err;
    throw new Error('delegation_store_corrupt', { cause: err });
  }
}

function load(): DelegationStoreFile {
  return loadCache().store;
}

function save(store: DelegationStoreFile): void {
  invalidateDelegationStoreCache();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // best effort
  }
  const path = storePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function createDelegation(params: {
  mailbox: string;
  grantee: string;
  scopes?: string[];
  createdBy: string;
  id?: string;
  createdAt?: string;
}): DelegationGrant {
  const store = load();
  const mailbox = params.mailbox.trim().toLowerCase();
  const grantee = params.grantee.trim().toLowerCase();
  const existing = store.grants.find(
    (g) => g.revokedAt === null && g.mailbox === mailbox && g.grantee === grantee,
  );
  if (existing) {
    return existing;
  }
  const rawScopes = params.scopes && params.scopes.length > 0 ? [...params.scopes] : ['read:messages'];
  const scopes = rawScopes.filter((s) => typeof s === 'string' && isSupportedScope(s));
  if (scopes.length === 0) {
    throw new Error('invalid_scopes: no supported scopes provided');
  }
  const grant: DelegationGrant = {
    id: params.id ?? `delg_${randomBytes(12).toString('hex')}`,
    mailbox,
    grantee,
    scopes,
    createdAt: params.createdAt ?? new Date().toISOString(),
    createdBy: params.createdBy,
    revokedAt: null,
    revokedBy: null,
  };
  store.grants.push(grant);
  save(store);
  return grant;
}

export function getDelegation(id: string): DelegationGrant | undefined {
  const store = load();
  return store.grants.find((g) => g.id === id);
}

/**
 * load() 整条剔除的 grant（如手工植入全不支持 scope 的脏数据）：返回其原始视图。
 * 供 DELETE /v1/delegations/:id 做授权与幂等撤销「磁盘残留」——这类 id 对
 * getDelegation / listDelegations 不可见（Issue #136 R2 顺清 3）。
 */
export function getDroppedDelegation(id: string): DelegationGrant | undefined {
  return loadCache().droppedGrants.find((g) => g.id === id);
}

export function listDelegations(filter?: {
  mailbox?: string;
  grantee?: string;
}): DelegationGrant[] {
  const store = load();
  let result = store.grants;
  if (filter?.mailbox) {
    const mb = filter.mailbox.trim().toLowerCase();
    result = result.filter((g) => g.mailbox === mb);
  }
  if (filter?.grantee) {
    const gt = filter.grantee.trim().toLowerCase();
    result = result.filter((g) => g.grantee === gt);
  }
  return result;
}

export function findActiveDelegation(
  mailbox: string,
  grantee: string,
  requiredScope?: string,
): DelegationGrant | undefined {
  const grants = listDelegations({ mailbox, grantee });
  return grants.find((g) => {
    if (g.revokedAt !== null) return false;
    if (requiredScope && !g.scopes.includes(requiredScope)) return false;
    return true;
  });
}

export function hasActiveDelegation(
  mailbox: string,
  grantee: string,
  requiredScope?: string,
): boolean {
  return findActiveDelegation(mailbox, grantee, requiredScope) !== undefined;
}

/**
 * 撤销委托：写入 revokedAt 墓碑。
 * 幂等：若已撤销，保留原 revokedAt / revokedBy 返回。
 * 被 load() 整条剔除的 grant 同样可撤销（磁盘原始记录就地落墓碑）。
 */
export function revokeDelegation(
  id: string,
  revokedBy: string,
  revokedAt?: string,
): DelegationGrant | null {
  const store = load();
  const grant = store.grants.find((g) => g.id === id);
  if (!grant) {
    return revokeDroppedGrant(id, revokedBy, revokedAt);
  }
  if (grant.revokedAt !== null) {
    return grant;
  }
  grant.revokedAt = revokedAt ?? new Date().toISOString();
  grant.revokedBy = revokedBy;
  save(store);
  return grant;
}

/**
 * 撤销被 load() 剔除的 grant：coerced store 不含它（save() 不会带走），
 * 故直接在磁盘原始记录上落墓碑，保持墓碑语义可审计。幂等：已撤销则原样返回。
 */
function revokeDroppedGrant(
  id: string,
  revokedBy: string,
  revokedAt?: string,
): DelegationGrant | null {
  const dropped = getDroppedDelegation(id);
  if (!dropped) return null;
  if (dropped.revokedAt !== null) return dropped;

  const path = storePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error('delegation_store_corrupt', { cause: err });
  }
  if (!isDelegationStoreShape(parsed)) {
    throw new Error('delegation_store_corrupt', {
      cause: new Error('invalid delegation store shape'),
    });
  }
  const entry = (parsed.grants as Record<string, unknown>[]).find((g) => g.id === id);
  if (!entry) return null;
  if (typeof entry.revokedAt === 'string' && entry.revokedAt) {
    // 磁盘上已被撤销（剔除视图落后于文件）：刷新缓存后按幂等语义返回。
    invalidateDelegationStoreCache();
    return getDroppedDelegation(id) ?? null;
  }
  const ts = revokedAt ?? new Date().toISOString();
  entry.revokedAt = ts;
  entry.revokedBy = revokedBy;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  invalidateDelegationStoreCache();
  return { ...dropped, revokedAt: ts, revokedBy };
}

function cascadeRevokeGrants(
  predicate: (grant: DelegationGrant) => boolean,
  opts?: { actor?: string; ts?: string },
): number {
  const store = load();
  const toRevoke = store.grants.filter((g) => g.revokedAt === null && predicate(g));
  if (toRevoke.length === 0) return 0;

  const now = opts?.ts ?? new Date().toISOString();
  const actor = opts?.actor ?? 'cascade';

  for (const grant of toRevoke) {
    grant.revokedAt = now;
    grant.revokedBy = actor;
  }

  save(store);

  for (const grant of toRevoke) {
    recordAuditEvent({
      event: 'delegation.revoke.cascade',
      outcome: 'ok',
      grantId: grant.id,
      actor,
      mailbox: grant.mailbox,
      grantee: grant.grantee,
      scopes: grant.scopes,
      ...(opts?.ts ? { ts: opts.ts } : {}),
    });
  }

  return toRevoke.length;
}

/**
 * 级联撤销：当某一身份被删除时，双向级联撤销（作为 owner 授出 + 作为 grantee 被授）。
 */
export function revokeDelegationsForAddress(
  address: string,
  opts?: { actor?: string; ts?: string },
): number {
  const needle = address.trim().toLowerCase();
  return cascadeRevokeGrants((g) => g.mailbox === needle || g.grantee === needle, opts);
}

/**
 * 级联撤销：当受托人（grantee）轮换 token 时级联撤销（owner 轮换不撤）。
 */
export function revokeDelegationsOnGranteeTokenRotate(
  granteeAddress: string,
  opts?: { actor?: string; ts?: string },
): number {
  const needle = granteeAddress.trim().toLowerCase();
  return cascadeRevokeGrants((g) => g.grantee === needle, opts);
}

/** 测试辅助：清空存储与缓存 */
export function resetDelegationStoreForTests(): void {
  invalidateDelegationStoreCache();
  const path = storePath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
  }
}
