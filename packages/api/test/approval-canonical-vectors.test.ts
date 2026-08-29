import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/approval-canonical-vectors.v1.json';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
const { approvalActionDigest, canonicalApprovalAction } = await import('../src/lib/tasks.ts');

const V1_HEADER = {
  format: 'openagentemail.approval-canonical-vectors',
  version: 1,
  digest: { algorithm: 'sha256', encoding: 'hex-lowercase', prefix: '' },
};
const VECTOR_IDS = ['unicode-v1', 'number-boundaries-v1', 'nested-order-v1'];
const CANONICAL_BY_ID: Record<string, string> = {
  'unicode-v1': '{"arguments":{"combining":"é","emoji":"😀","雪":"東京"},"name":"café","type":"tool_call"}',
  'number-boundaries-v1': '{"arguments":{"decimal":0.000001,"exponentHigh":1e+21,"exponentLow":1e-7,"fraction":1.23,"integers":[0,0,9007199254740991],"negativeZero":0},"name":"numeric-boundaries","type":"tool_call"}',
  'nested-order-v1': '{"arguments":{"a":{"x":1,"y":2},"z":[{"a":1,"b":2},["x",{"α":null,"β":true}]]},"name":"nested","type":"tool_call"}',
};
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function sameKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function invalid(message: string): never { throw new Error(`invalid public v1 vector fixture: ${message}`); }
function validateActionShape(value: unknown, label: string) {
  if (!isRecord(value) || !sameKeys(value, ['type', 'name', 'arguments']) ||
      typeof value.type !== 'string' || !value.type || typeof value.name !== 'string' || !value.name ||
      !Object.hasOwn(value, 'arguments')) invalid(`${label} action shape`);
}
function validateMutation(value: unknown, label: string) {
  if (!isRecord(value) || !sameKeys(value, ['path', 'value', 'sha256']) ||
      typeof value.path !== 'string' || !value.path || !Object.hasOwn(value, 'value') ||
      typeof value.sha256 !== 'string' || !HEX_SHA256.test(value.sha256)) invalid(`${label} mutation`);
}
function validateV1Fixture(candidate: unknown) {
  if (!isRecord(candidate) || candidate.format !== V1_HEADER.format || candidate.version !== V1_HEADER.version ||
      !isRecord(candidate.digest) || !sameKeys(candidate.digest, ['algorithm', 'encoding', 'prefix']) ||
      candidate.digest.algorithm !== V1_HEADER.digest.algorithm || candidate.digest.encoding !== V1_HEADER.digest.encoding ||
      candidate.digest.prefix !== V1_HEADER.digest.prefix || !Array.isArray(candidate.vectors) ||
      candidate.vectors.length !== VECTOR_IDS.length) invalid('header, digest, or vector count');
  const byId = new Map<string, Record<string, any>>();
  for (const vector of candidate.vectors) {
    if (!isRecord(vector) || typeof vector.id !== 'string' || byId.has(vector.id)) invalid('vector id');
    byId.set(vector.id, vector);
  }
  if (VECTOR_IDS.some((id) => !byId.has(id))) invalid('required vector ids');
  for (const id of VECTOR_IDS) {
    const vector = byId.get(id)!;
    const keys = id === 'nested-order-v1'
      ? ['id', 'source', 'equivalentSource', 'canonicalUtf8Json', 'sha256', 'mutations']
      : ['id', 'source', 'canonicalUtf8Json', 'sha256', 'mutations'];
    if (!sameKeys(vector, keys) || typeof vector.canonicalUtf8Json !== 'string' ||
        vector.canonicalUtf8Json !== CANONICAL_BY_ID[id] || typeof vector.sha256 !== 'string' ||
        !HEX_SHA256.test(vector.sha256) || !Array.isArray(vector.mutations) || !vector.mutations.length) invalid(`${id} required shape`);
    validateActionShape(vector.source, `${id} source`);
    vector.mutations.forEach((mutation: unknown) => validateMutation(mutation, id));
  }
  const unicode = byId.get('unicode-v1')!;
  if (unicode.source.arguments?.emoji !== '😀' || typeof unicode.source.arguments?.combining !== 'string' ||
      unicode.source.arguments?.雪 !== '東京') invalid('unicode content');
  const number = byId.get('number-boundaries-v1')!;
  if (!Object.is(number.source.arguments?.negativeZero, -0)) invalid('number-boundaries raw -0');
  const nested = byId.get('nested-order-v1')!;
  validateActionShape(nested.equivalentSource, 'nested equivalentSource');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('non-finite'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('not plain JSON');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function action(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid action');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || typeof input.type !== 'string' || !input.type || typeof input.name !== 'string' || !input.name || !Object.hasOwn(input, 'arguments')) throw new Error('invalid action');
  return input;
}
function digest(value: unknown) { return createHash('sha256').update(canonical(action(value)), 'utf8').digest('hex'); }
function mutated(source: any, path: string, value: unknown) {
  const result = structuredClone(source); const keys = path.split('.'); let target = result;
  for (const key of keys.slice(0, -1)) target = target[key]; target[keys.at(-1)!] = value; return result;
}

test('public v1 vectors are independently reproducible and production agrees', () => {
  validateV1Fixture(fixture);
  for (const vector of fixture.vectors) {
    if (vector.id === 'number-boundaries-v1') {
      // JSON permits the -0 token. Preserve that source fact independently before
      // checking the v1 recipe's JSON.stringify normalization to canonical 0.
      expect(Object.is(vector.source.arguments.negativeZero, -0)).toBe(true);
    }
    expect(canonical(action(vector.source))).toBe(vector.canonicalUtf8Json);
    expect(digest(vector.source)).toBe(vector.sha256);
    expect(canonicalApprovalAction(vector.source)).toBe(vector.canonicalUtf8Json);
    expect(approvalActionDigest(vector.source)).toBe(vector.sha256);
    if ('equivalentSource' in vector && vector.equivalentSource) expect(digest(vector.equivalentSource)).toBe(vector.sha256);
    for (const mutation of vector.mutations) {
      const changed = mutated(vector.source, mutation.path, mutation.value);
      expect(digest(changed)).toBe(mutation.sha256);
      expect(digest(changed)).not.toBe(vector.sha256);
      expect(approvalActionDigest(changed)).toBe(mutation.sha256);
    }
  }
});

test('public v1 fixture validation fails closed on incomplete or malformed data', () => {
  expect(() => validateV1Fixture({ ...fixture, vectors: [] })).toThrow('vector count');
  expect(() => validateV1Fixture({ ...fixture, vectors: fixture.vectors.slice(0, 2) })).toThrow('vector count');
  const missingEquivalent = structuredClone(fixture) as any;
  delete missingEquivalent.vectors[2].equivalentSource;
  expect(() => validateV1Fixture(missingEquivalent)).toThrow('nested-order-v1 required shape');
  const missingMutations = structuredClone(fixture) as any;
  missingMutations.vectors[0].mutations = [];
  expect(() => validateV1Fixture(missingMutations)).toThrow('unicode-v1 required shape');
  const malformedDigest = structuredClone(fixture) as any;
  malformedDigest.vectors[1].sha256 = 'ABC';
  expect(() => validateV1Fixture(malformedDigest)).toThrow('number-boundaries-v1 required shape');
});
