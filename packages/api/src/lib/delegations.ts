// Single-writer process assumption: Like identities.json, delegations.json assumes a
// single-writer process and does not support multi-process concurrent mutations on the same DATA_DIR.
// Scope note: Currently delegations only support 'read:messages'. If additional scopes are
// introduced in the future, all forbidUnlessMailboxAccess call sites must be audited to ensure
// delegations do not unintentionally grant write or admin capabilities.

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

function coerceGrant(raw: Record<string, unknown>): DelegationGrant {
  return {
    ...raw,
    id: raw.id as string,
    mailbox: (raw.mailbox as string).trim().toLowerCase(),
    grantee: (raw.grantee as string).trim().toLowerCase(),
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
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

function load(): DelegationStoreFile {
  const path = storePath();
  if (!existsSync(path)) {
    if (storeCache && storeVersionsEqual(storeCache.version, MISSING_STORE_VERSION)) {
      return storeCache.store;
    }
    storeCache = {
      version: MISSING_STORE_VERSION,
      store: {
        schemaVersion: DELEGATION_STORE_SCHEMA_VERSION,
        grants: [],
      },
    };
    return storeCache.store;
  }
  try {
    const version = fileVersionFromStat(statSync(path));
    if (storeCache && storeVersionsEqual(storeCache.version, version)) {
      return storeCache.store;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isDelegationStoreShape(parsed)) {
      throw new Error('invalid delegation store shape');
    }
    const grants = parsed.grants.map((entry) => coerceGrant(entry as Record<string, unknown>));
    const store: DelegationStoreFile = {
      ...parsed,
      schemaVersion: DELEGATION_STORE_SCHEMA_VERSION,
      grants,
    };
    storeCache = {
      version,
      store,
    };
    return storeCache.store;
  } catch (err) {
    invalidateDelegationStoreCache();
    if ((err as Error).message === 'delegation_store_corrupt') throw err;
    throw new Error('delegation_store_corrupt');
  }
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
  const grant: DelegationGrant = {
    id: params.id ?? `delg_${randomBytes(12).toString('hex')}`,
    mailbox,
    grantee,
    scopes: params.scopes && params.scopes.length > 0 ? [...params.scopes] : ['read:messages'],
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
 */
export function revokeDelegation(
  id: string,
  revokedBy: string,
  revokedAt?: string,
): DelegationGrant | null {
  const store = load();
  const grant = store.grants.find((g) => g.id === id);
  if (!grant) return null;
  if (grant.revokedAt !== null) {
    return grant;
  }
  grant.revokedAt = revokedAt ?? new Date().toISOString();
  grant.revokedBy = revokedBy;
  save(store);
  return grant;
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
