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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

function storePath(): string {
  return join(config.dataDir, 'oauth.json');
}

function emptyStore(): OAuthStoreFile {
  return { grants: {}, codes: {}, access: {}, refresh: {} };
}

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

function load(): OAuthStoreFile {
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
      return storeCache.data;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isStoreShape(parsed)) {
      throw new Error('invalid oauth store shape');
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

function save(data: OAuthStoreFile): void {
  invalidateStoreCache();
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
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
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
  const address = auth.address!.toLowerCase();
  return all
    .filter((g) => g.address.toLowerCase() === address)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    if (row.grantId === grantId) delete data.access[hash];
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

/** 一次性消费授权码（先删再返回，防重放）。 */
export function consumeAuthorizationCode(
  code: string,
  now = Date.now(),
): ConsumeCodeResult {
  const data = load();
  const hash = hashSecret(code);
  const row = data.codes[hash];
  if (!row) return { ok: false, reason: 'not_found' };
  delete data.codes[hash];
  save(data);
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
  | { ok: false; reason: 'not_found' | 'expired' | 'grant_missing' };

/** refresh 轮换：旧 refresh 立即作废，签发新 access+refresh。 */
export function rotateRefreshToken(
  refreshToken: string,
  now = Date.now(),
): RotateRefreshResult {
  const data = load();
  const hash = hashSecret(refreshToken);
  const row = data.refresh[hash];
  if (!row) return { ok: false, reason: 'not_found' };
  delete data.refresh[hash];
  if (row.expiresAt <= now) {
    save(data);
    return { ok: false, reason: 'expired' };
  }
  if (!data.grants[row.grantId]) {
    save(data);
    return { ok: false, reason: 'grant_missing' };
  }
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

/** RFC 7009：吊销 access 或 refresh（未知令牌亦视为成功）。 */
export function revokeToken(token: string): void {
  const data = load();
  const hash = hashSecret(token);
  let changed = false;
  if (data.access[hash]) {
    delete data.access[hash];
    changed = true;
  }
  if (data.refresh[hash]) {
    delete data.refresh[hash];
    changed = true;
  }
  if (changed) save(data);
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
  // 线性扫描以支持常量时间比较（条目少；哈希作键时先直查）
  const row = data.access[hash];
  if (!row) {
    // 防枚举：对不匹配键做一次哑比较
    hashEquals(hash, hash);
    return { status: 'missing' };
  }
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
  const data = load();
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
  save(data);
}
