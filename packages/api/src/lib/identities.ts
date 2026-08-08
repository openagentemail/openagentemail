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

/** Mail-arrival push content detail. 1 = interrupt only (default), 2 = +subject/from, 3 = +body preview/OTP. */
export type PushContentTier = 1 | 2 | 3;

export const DEFAULT_PUSH_CONTENT_TIER: PushContentTier = 1;

/** Shown when tier 3 is set or returned; body/OTP leave the server via ntfy. */
export const PUSH_TIER3_WARNING =
  'Tier 3 includes message body previews and OTP codes/links in push notifications. That content leaves this server for the ntfy channel.';

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
    (identity.tokenHash === undefined || typeof identity.tokenHash === 'string')
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
  return load().find((i) => i.tokenHash && hashEquals(i.tokenHash, hash));
}

/** Returns the created identity plus its one-time plaintext token, or null if taken. */
export function createIdentity(input: {
  name?: string;
  localpart?: string;
  canNotifyUser?: boolean;
}): { identity: Identity; token: string } | null {
  const identities = load();
  let localpart = input.localpart?.toLowerCase();
  if (localpart) {
    if (!LOCALPART_RE.test(localpart)) {
      throw new Error('invalid_localpart');
    }
  } else {
    // Retry a few times on the off chance of a random collision.
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = randomLocalpart();
      if (!identities.some((i) => i.address === `${candidate}@${config.domain}`)) {
        localpart = candidate;
        break;
      }
    }
    if (!localpart) throw new Error('localpart_collision');
  }

  const address = `${localpart}@${config.domain}`;
  if (identities.some((i) => i.address === address)) return null;

  const { token, tokenHash } = generateToken();
  const identity: Identity = {
    address,
    ...(input.name ? { name: input.name } : {}),
    ...(input.canNotifyUser ? { canNotifyUser: true } : {}),
    createdAt: new Date().toISOString(),
    tokenHash,
  };
  identities.push(identity);
  save(identities);
  return { identity, token };
}

/**
 * Replace an identity's token (the old one stops working immediately).
 * Returns the new plaintext token, or null if the address doesn't exist.
 */
export function rotateIdentityToken(address: string): string | null {
  const identities = load();
  const needle = address.toLowerCase();
  const identity = identities.find((i) => i.address === needle);
  if (!identity) return null;
  const { token, tokenHash } = generateToken();
  identity.tokenHash = tokenHash;
  save(identities);
  return token;
}

/**
 * Remove an identity (its mail stays in the catch-all until retention
 * sweeps it). Returns false if the address didn't exist.
 */
export function deleteIdentity(address: string): boolean {
  const identities = load();
  const needle = address.toLowerCase();
  const kept = identities.filter((i) => i.address !== needle);
  if (kept.length === identities.length) return false;
  save(kept);
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
