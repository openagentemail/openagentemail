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

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export interface Identity {
  address: string;
  name?: string;
  createdAt: string;
  /** Explicit root-level permission to notify the human-alert topics. */
  canNotifyUser?: boolean;
  /** SHA-256 hex of the identity's API token. Absent on pre-token stores. */
  tokenHash?: string;
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

function isIdentity(value: unknown): value is Identity {
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

function load(): Identity[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isIdentity)) {
      throw new Error('invalid identity store shape');
    }
    return parsed;
  } catch {
    // Fail closed. Treating a damaged store as empty looks harmless until the
    // next create/rotate saves over it: every existing identity and token is
    // gone. The message carries no file content on purpose.
    throw new Error('identity_store_corrupt');
  }
}

function save(identities: Identity[]): void {
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
  const needle = address.toLowerCase();
  return load().find((i) => i.address === needle);
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
