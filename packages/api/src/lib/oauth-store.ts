/**
 * OAuth 令牌/授权存储（oauth.json）。
 * 模式照抄 identities.json：单写者、tmp+rename、0600、只存哈希、损坏 fail-closed。
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
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type OAuthGrant = {
  id: string;
  clientId: string;
  clientName: string;
  address: string;
  createdAt: string;
  lastUsedAt: string;
};

export type OAuthCode = {
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  address: string;
  expiresAt: number;
};

export type OAuthAccess = {
  grantId: string;
  address: string;
  aud: string;
  expiresAt: number;
};

export type OAuthRefresh = {
  grantId: string;
  address: string;
  aud: string;
  expiresAt: number;
};

type OAuthStoreFile = {
  grants: Record<string, OAuthGrant>;
  codes: Record<string, OAuthCode>;
  access: Record<string, OAuthAccess>;
  refresh: Record<string, OAuthRefresh>;
};

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
  data: OAuthStoreFile;
};

let storeCache: StoreCache | undefined;
let rawCache: StoreCache | undefined;

/** Bounded in-process tombstone set for pruned OAuth access-token hashes. */
export const PRUNED_ACCESS_HASHES_CAP = 10_000;
const prunedAccessHashes = new Set<string>();

export function recordPrunedAccessHash(hash: string): void {
  if (prunedAccessHashes.has(hash)) {
    prunedAccessHashes.delete(hash);
    prunedAccessHashes.add(hash);
    return;
  }
  if (prunedAccessHashes.size >= PRUNED_ACCESS_HASHES_CAP) {
    const oldest = prunedAccessHashes.values().next().value;
    if (oldest !== undefined) {
      prunedAccessHashes.delete(oldest);
    }
  }
  prunedAccessHashes.add(hash);
}

export function getPrunedAccessHashesCountForTests(): number {
  return prunedAccessHashes.size;
}

export function clearPrunedAccessHashesForTests(): void {
  prunedAccessHashes.clear();
}

function storePath(): string {
  return join(config.dataDir, 'oauth.json');
}

function emptyStore(): OAuthStoreFile {
  return { grants: {}, codes: {}, access: {}, refresh: {} };
}

export function invalidateStoreCache(): void {
  storeCache = undefined;
  rawCache = undefined;
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

function isGrant(v: unknown): v is OAuthGrant {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.id === 'string' &&
    typeof g.clientId === 'string' &&
    typeof g.clientName === 'string' &&
    typeof g.address === 'string' &&
    typeof g.createdAt === 'string' &&
    typeof g.lastUsedAt === 'string'
  );
}

function isCode(v: unknown): v is OAuthCode {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.grantId === 'string' &&
    typeof c.clientId === 'string' &&
    typeof c.redirectUri === 'string' &&
    typeof c.codeChallenge === 'string' &&
    typeof c.resource === 'string' &&
    typeof c.address === 'string' &&
    typeof c.expiresAt === 'number'
  );
}

function isAccess(v: unknown): v is OAuthAccess {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.grantId === 'string' &&
    typeof a.address === 'string' &&
    typeof a.aud === 'string' &&
    typeof a.expiresAt === 'number'
  );
}

function isRefresh(v: unknown): v is OAuthRefresh {
  return isAccess(v);
}

function isStoreShape(value: unknown): value is OAuthStoreFile {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (!s.grants || typeof s.grants !== 'object') return false;
  if (!s.codes || typeof s.codes !== 'object') return false;
  if (!s.access || typeof s.access !== 'object') return false;
  if (!s.refresh || typeof s.refresh !== 'object') return false;
  return (
    Object.values(s.grants as object).every(isGrant) &&
    Object.values(s.codes as object).every(isCode) &&
    Object.values(s.access as object).every(isAccess) &&
    Object.values(s.refresh as object).every(isRefresh)
  );
}

/** 清掉 codes/access/refresh 过期行（load/save 时调用）。 */
function pruneExpired(data: OAuthStoreFile, now = Date.now()): boolean {
  let changed = false;
  for (const [hash, row] of Object.entries(data.codes)) {
    if (row.expiresAt <= now) {
      delete data.codes[hash];
      changed = true;
    }
  }
  for (const [hash, row] of Object.entries(data.access)) {
    if (row.expiresAt <= now) {
      delete data.access[hash];
      recordPrunedAccessHash(hash);
      changed = true;
    }
  }
  for (const [hash, row] of Object.entries(data.refresh)) {
    if (row.expiresAt <= now) {
      delete data.refresh[hash];
      changed = true;
    }
  }
  return changed;
}

function loadRaw(): OAuthStoreFile {
  const path = storePath();
  if (!existsSync(path)) {
    if (rawCache && storeVersionsEqual(rawCache.version, MISSING_STORE_VERSION)) {
      return rawCache.data;
    }
    rawCache = { version: MISSING_STORE_VERSION, data: emptyStore() };
    return rawCache.data;
  }
  try {
    const version = fileVersionFromStat(statSync(path));
    if (rawCache && storeVersionsEqual(rawCache.version, version)) {
      return rawCache.data;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isStoreShape(parsed)) {
      throw new Error('invalid oauth store shape');
    }
    rawCache = { version, data: parsed };
    return rawCache.data;
  } catch (err) {
    rawCache = undefined;
    if ((err as Error).message === 'oauth_store_corrupt') throw err;
    throw new Error('oauth_store_corrupt');
  }
}

/**
 * Non-destructive existence check in access table without pruning and without
 * expiry evaluation. Used exclusively by auth credential discrimination when
 * the identity store is damaged. Returns true if the token exists in the access
 * table OR has been recorded in the bounded prunedAccessHashes tombstone set.
 */
export function peekAccessToken(token: string): boolean {
  try {
    const hash = hashSecret(token);
    if (prunedAccessHashes.has(hash)) {
      return true;
    }
    const data = loadRaw();
    return Boolean(data.access[hash]);
  } catch {
    return false;
  }
}

/**
 * @param persistPrune 冷读发现过期行时是否写回磁盘。
 * 公开 /oauth/revoke 用 false：未知 token 路径必须零磁盘写（防未鉴权写放大）。
 */
function load(persistPrune = true): OAuthStoreFile {
  const path = storePath();
  if (!existsSync(path)) {
    if (storeCache && storeVersionsEqual(storeCache.version, MISSING_STORE_VERSION)) {
      return storeCache.data;
    }
    storeCache = { version: MISSING_STORE_VERSION, data: emptyStore() };
    return storeCache.data;
  }
  try {
    const version = fileVersionFromStat(statSync(path));
    if (storeCache && storeVersionsEqual(storeCache.version, version)) {
      // 缓存命中也做内存 prune（不强制写盘，避免热路径 IO）
      pruneExpired(storeCache.data);
      return storeCache.data;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isStoreShape(parsed)) {
      throw new Error('invalid oauth store shape');
    }
    if (pruneExpired(parsed)) {
      if (persistPrune) {
        // 读时发现过期行：就地写回，避免 save→load 递归
        const written = writeStoreFile(parsed);
        storeCache = { version: written, data: parsed };
        return storeCache.data;
      }
      // revoke 热路径：只内存 prune，不写盘
    }
    storeCache = { version, data: parsed };
    return storeCache.data;
  } catch (err) {
    invalidateStoreCache();
    if ((err as Error).message === 'oauth_store_corrupt') throw err;
    // 损坏 fail-closed：绝不当空库写回，避免抹掉全部授权。
    throw new Error('oauth_store_corrupt');
  }
}

function writeStoreFile(data: OAuthStoreFile): StoreFileVersion {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // bind mount 可能属主不同；文件 mode 仍会设置
  }
  const path = storePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return fileVersionFromStat(statSync(path));
}

function save(data: OAuthStoreFile): void {
  pruneExpired(data);
  invalidateStoreCache();
  const version = writeStoreFile(data);
  storeCache = { version, data: structuredClone(data) };
  rawCache = { version, data: structuredClone(data) };
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 生成不透明令牌明文（32 字节）及其哈希。 */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSecret(token) };
}

export function newGrantId(): string {
  return randomBytes(16).toString('base64url');
}

/** 测试用：清空进程内缓存（不删文件）。 */
export function resetOAuthStoreCacheForTests(): void {
  invalidateStoreCache();
}

export function listGrantsForAuth(auth: {
  kind: 'admin' | 'identity';
  address?: string;
}): OAuthGrant[] {
  const data = load();
  const all = Object.values(data.grants);
  if (auth.kind === 'admin') {
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (typeof auth.address !== 'string' || !auth.address) {
    return [];
  }
  const address = auth.address.toLowerCase();
  return all
    .filter((g) => g.address.toLowerCase() === address)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 身份删除时级联吊销：该地址下全部 grant + 挂接 token。 */
export function revokeGrantsForAddress(address: string): number {
  const data = load();
  const needle = address.toLowerCase();
  const grantIds = Object.keys(data.grants).filter(
    (id) => data.grants[id]!.address.toLowerCase() === needle,
  );
  if (grantIds.length === 0) return 0;
  for (const grantId of grantIds) {
    delete data.grants[grantId];
    for (const [hash, row] of Object.entries(data.codes)) {
      if (row.grantId === grantId) delete data.codes[hash];
    }
    for (const [hash, row] of Object.entries(data.access)) {
      if (row.grantId === grantId) {
        delete data.access[hash];
        recordPrunedAccessHash(hash);
      }
    }
    for (const [hash, row] of Object.entries(data.refresh)) {
      if (row.grantId === grantId) delete data.refresh[hash];
    }
  }
  save(data);
  return grantIds.length;
}

export function getGrant(grantId: string): OAuthGrant | undefined {
  return load().grants[grantId];
}

/**
 * 吊销 grant：删 grant 行及挂在其上的全部 code/access/refresh。
 * @returns false 表示 grant 不存在
 */
export function revokeGrant(grantId: string): boolean {
  const data = load();
  if (!data.grants[grantId]) return false;
  delete data.grants[grantId];
  for (const [hash, row] of Object.entries(data.codes)) {
    if (row.grantId === grantId) delete data.codes[hash];
  }
  for (const [hash, row] of Object.entries(data.access)) {
    if (row.grantId === grantId) {
      delete data.access[hash];
      recordPrunedAccessHash(hash);
    }
  }
  for (const [hash, row] of Object.entries(data.refresh)) {
    if (row.grantId === grantId) delete data.refresh[hash];
  }
  save(data);
  return true;
}

export function createGrantAndCode(input: {
  clientId: string;
  clientName: string;
  address: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  now?: number;
}): { grantId: string; code: string } {
  const now = input.now ?? Date.now();
  const data = load();
  const grantId = newGrantId();
  const createdAt = new Date(now).toISOString();
  data.grants[grantId] = {
    id: grantId,
    clientId: input.clientId,
    clientName: input.clientName,
    address: input.address.toLowerCase(),
    createdAt,
    lastUsedAt: createdAt,
  };
  const { token: code, hash } = generateOpaqueToken();
  data.codes[hash] = {
    grantId,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    address: input.address.toLowerCase(),
    expiresAt: now + CODE_TTL_MS,
  };
  save(data);
  return { grantId, code };
}

export type ConsumeCodeResult =
  | {
      ok: true;
      grantId: string;
      address: string;
      resource: string;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
    }
  | { ok: false; reason: 'not_found' | 'expired' };

export type CodeRowView = {
  grantId: string;
  address: string;
  resource: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
};

/** 只读查看授权码（不删除）；供全量校验后再原子消费。 */
export function peekAuthorizationCode(
  code: string,
  now = Date.now(),
): ConsumeCodeResult {
  const data = load();
  const hash = hashSecret(code);
  const row = data.codes[hash];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    grantId: row.grantId,
    address: row.address,
    resource: row.resource,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
  };
}

/**
 * 原子消费授权码：仍存在则删除并返回行。
 * 调用方应先 peek + 全量校验（client/redirect/resource/PKCE），再调用本函数签发。
 * 拦截者无 verifier 时只能制造一次「合法交换不可用」，不能靠抢删骗过 PKCE。
 */
export function consumeAuthorizationCode(
  code: string,
  now = Date.now(),
): ConsumeCodeResult {
  const data = load();
  const hash = hashSecret(code);
  const row = data.codes[hash];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expiresAt <= now) {
    delete data.codes[hash];
    save(data);
    return { ok: false, reason: 'expired' };
  }
  delete data.codes[hash];
  save(data);
  return {
    ok: true,
    grantId: row.grantId,
    address: row.address,
    resource: row.resource,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
  };
}

export function issueTokenPair(input: {
  grantId: string;
  address: string;
  aud: string;
  now?: number;
}): { accessToken: string; refreshToken: string; expiresIn: number } {
  const now = input.now ?? Date.now();
  const data = load();
  if (!data.grants[input.grantId]) {
    throw new Error('grant_missing');
  }
  data.grants[input.grantId].lastUsedAt = new Date(now).toISOString();
  const access = generateOpaqueToken();
  const refresh = generateOpaqueToken();
  data.access[access.hash] = {
    grantId: input.grantId,
    address: input.address.toLowerCase(),
    aud: input.aud,
    expiresAt: now + ACCESS_TTL_MS,
  };
  data.refresh[refresh.hash] = {
    grantId: input.grantId,
    address: input.address.toLowerCase(),
    aud: input.aud,
    expiresAt: now + REFRESH_TTL_MS,
  };
  save(data);
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
  };
}

export type RotateRefreshResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      address: string;
      aud: string;
      grantId: string;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'grant_missing'
        | 'aud_mismatch'
        | 'client_mismatch';
    };

export type RotateRefreshOptions = {
  now?: number;
  /** 期望 aud；不匹配时**不**吞旧票写新行。 */
  expectedAud?: string;
  /** RFC 6749 §6：public client 必须带 client_id 且与 grant 绑定。 */
  clientId?: string;
};

/**
 * refresh 轮换：先验 aud/client/过期/grant，全部通过后再删旧票写新行。
 */
export function rotateRefreshToken(
  refreshToken: string,
  nowOrOpts: number | RotateRefreshOptions = Date.now(),
): RotateRefreshResult {
  const opts: RotateRefreshOptions =
    typeof nowOrOpts === 'number' ? { now: nowOrOpts } : nowOrOpts;
  const now = opts.now ?? Date.now();
  const data = load();
  const hash = hashSecret(refreshToken);
  const row = data.refresh[hash];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expiresAt <= now) {
    // 过期行可清掉；不算「轮换成功」
    delete data.refresh[hash];
    save(data);
    return { ok: false, reason: 'expired' };
  }
  if (!data.grants[row.grantId]) {
    return { ok: false, reason: 'grant_missing' };
  }
  if (opts.expectedAud !== undefined && row.aud !== opts.expectedAud) {
    // aud 不符：保留旧 refresh，禁止先写库再拒
    return { ok: false, reason: 'aud_mismatch' };
  }
  if (opts.clientId !== undefined) {
    const grant = data.grants[row.grantId]!;
    if (grant.clientId !== opts.clientId) {
      return { ok: false, reason: 'client_mismatch' };
    }
  }

  // 校验全过：原子删除旧 refresh 并签发
  delete data.refresh[hash];
  data.grants[row.grantId].lastUsedAt = new Date(now).toISOString();
  const access = generateOpaqueToken();
  const refresh = generateOpaqueToken();
  data.access[access.hash] = {
    grantId: row.grantId,
    address: row.address,
    aud: row.aud,
    expiresAt: now + ACCESS_TTL_MS,
  };
  data.refresh[refresh.hash] = {
    grantId: row.grantId,
    address: row.address,
    aud: row.aud,
    expiresAt: now + REFRESH_TTL_MS,
  };
  save(data);
  return {
    ok: true,
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    address: row.address,
    aud: row.aud,
    grantId: row.grantId,
  };
}

/**
 * RFC 7009：吊销 access 或 refresh（未知令牌亦 200 成功语义，由路由保证）。
 * 必须带与 grant 绑定的 clientId；缺失或不匹配时**不删**（灭第三方持票 DoS）。
 * 未知/不匹配路径：**零磁盘写**（load 不 persist prune；不 save）——公开端点防写放大。
 * @returns true 表示确有删除；false 表示未删（未知票 / 无 client / 不匹配）
 */
export function revokeToken(token: string, clientId?: string): boolean {
  if (!clientId) return false;
  // persistPrune=false：未命中时不得因过期清理写 oauth.json
  const data = load(false);
  const hash = hashSecret(token);
  const access = data.access[hash];
  const refresh = data.refresh[hash];
  if (!access && !refresh) return false;
  const grantId = access?.grantId ?? refresh!.grantId;
  const grant = data.grants[grantId];
  if (!grant || grant.clientId !== clientId) return false;
  let changed = false;
  if (access) {
    delete data.access[hash];
    recordPrunedAccessHash(hash);
    changed = true;
  }
  if (refresh) {
    delete data.refresh[hash];
    changed = true;
  }
  // 只有真删行才写盘
  if (changed) save(data);
  return changed;
}

export type LookupAccessResult =
  | { status: 'ok'; address: string; aud: string; grantId: string; expiresAt: number }
  | { status: 'expired'; aud: string }
  | { status: 'missing' };

export function lookupAccessToken(
  token: string,
  now = Date.now(),
): LookupAccessResult {
  const data = load();
  const hash = hashSecret(token);
  const row = data.access[hash];
  if (!row) return { status: 'missing' };
  if (row.expiresAt <= now) return { status: 'expired', aud: row.aud };
  // grant 已吊销则 access 立即失效
  if (!data.grants[row.grantId]) return { status: 'missing' };
  return {
    status: 'ok',
    address: row.address,
    aud: row.aud,
    grantId: row.grantId,
    expiresAt: row.expiresAt,
  };
}

/** 测试辅助：直接写入过期 access（构造 401 场景）。 */
export function putAccessTokenForTests(input: {
  token: string;
  grantId: string;
  address: string;
  aud: string;
  expiresAt: number;
  ensureGrant?: { clientId: string; clientName: string };
}): void {
  const data = loadRaw();
  if (input.ensureGrant && !data.grants[input.grantId]) {
    const nowIso = new Date().toISOString();
    data.grants[input.grantId] = {
      id: input.grantId,
      clientId: input.ensureGrant.clientId,
      clientName: input.ensureGrant.clientName,
      address: input.address.toLowerCase(),
      createdAt: nowIso,
      lastUsedAt: nowIso,
    };
  }
  data.access[hashSecret(input.token)] = {
    grantId: input.grantId,
    address: input.address.toLowerCase(),
    aud: input.aud,
    expiresAt: input.expiresAt,
  };
  if (input.runSave) {
    save(data);
  } else {
    invalidateStoreCache();
    const version = writeStoreFile(data);
    rawCache = { version, data: structuredClone(data) };
    storeCache = { version, data: structuredClone(data) };
  }
}

export function saveStoreForTests(): void {
  const data = loadRaw();
  save(data);
}
