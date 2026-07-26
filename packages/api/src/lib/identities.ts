/**
 * Identity store. Identities are logical addresses (localpart@DOMAIN) that
 * all land in the single catch-all mailbox; the api matches messages to
 * identities by the To/Delivered-To header at read time.
 *
 * Persisted as a JSON file under DATA_DIR — simple and durable enough for
 * v0.1; swap for sqlite if identity volume ever matters.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { config } from './config.ts';

export interface Identity {
  address: string;
  name?: string;
  createdAt: string;
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

function load(): Identity[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Identity[]) : [];
  } catch {
    // Corrupt store: better to start empty than to wedge the service.
    return [];
  }
}

function save(identities: Identity[]): void {
  mkdirSync(config.dataDir, { recursive: true });
  const path = storePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(identities, null, 2));
  renameSync(tmp, path);
}

export function randomLocalpart(): string {
  const word = WORDS[randomInt(WORDS.length)];
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return `${word}-${suffix}`;
}

export function listIdentities(): Identity[] {
  return load();
}

export function findIdentity(address: string): Identity | undefined {
  const needle = address.toLowerCase();
  return load().find((i) => i.address === needle);
}

/** Returns the created identity, or null if the address is already taken. */
export function createIdentity(input: { name?: string; localpart?: string }): Identity | null {
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

  const identity: Identity = {
    address,
    ...(input.name ? { name: input.name } : {}),
    createdAt: new Date().toISOString(),
  };
  identities.push(identity);
  save(identities);
  return identity;
}
