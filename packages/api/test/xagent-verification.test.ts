/**
 * H1 / X-Agent 黑客松自证端点契约：
 * - /healthz 无 SOURCE_COMMIT → 逐字 {ok:true}
 * - /healthz 有 SOURCE_COMMIT → {status,commit,version} 三字段
 * - /.well-known/xagent-verification.json 双 env 齐 → 200+三字段；缺任一 → 404
 */
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { parseConfig } = await import('../src/lib/config.ts');
const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');

const pkg = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as { version: string };

/** 合法 40 位小写 hex（测试钉死，非真实仓 SHA） */
const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SLUG = 'openagent-email';

const requiredEnv: NodeJS.ProcessEnv = {
  DOMAIN: 'example.com',
  API_KEYS: 'admin-key',
  IMAP_USER: 'catch-all@example.com',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'catch-all@example.com',
  SMTP_PASS: 'smtp-secret',
};

describe('H1 config: SOURCE_COMMIT / XAGT_VERIFICATION_SLUG', () => {
  test('omits both when unset or blank', () => {
    const cfg = parseConfig(requiredEnv);
    expect(cfg.sourceCommit).toBeUndefined();
    expect(cfg.xagtVerificationSlug).toBeUndefined();
    const blank = parseConfig({
      ...requiredEnv,
      SOURCE_COMMIT: '   ',
      XAGT_VERIFICATION_SLUG: '',
    });
    expect(blank.sourceCommit).toBeUndefined();
    expect(blank.xagtVerificationSlug).toBeUndefined();
  });

  test('accepts 40-char lowercase hex and a non-empty slug', () => {
    const cfg = parseConfig({
      ...requiredEnv,
      SOURCE_COMMIT: COMMIT,
      XAGT_VERIFICATION_SLUG: SLUG,
    });
    expect(cfg.sourceCommit).toBe(COMMIT);
    expect(cfg.xagtVerificationSlug).toBe(SLUG);
  });

  test('rejects SOURCE_COMMIT that is not exactly 40 lowercase hex', () => {
    expect(() =>
      parseConfig({ ...requiredEnv, SOURCE_COMMIT: 'deadbeef' }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...requiredEnv,
        SOURCE_COMMIT: 'AAAAAAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...requiredEnv,
        SOURCE_COMMIT: `${COMMIT}0`,
      }),
    ).toThrow();
  });
});

describe('H1 /healthz two-state contract', () => {
  test('without SOURCE_COMMIT returns exactly {ok:true}', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = undefined;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = undefined;
      const app = createApp({ uiEnabled: false });
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
      // 逐字：不得多字段
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });

  test('with SOURCE_COMMIT returns status/commit/version pinned', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = COMMIT;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = undefined;
      const app = createApp({ uiEnabled: false });
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ok',
        commit: COMMIT,
        version: pkg.version,
      });
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });
});

describe('H1 /.well-known/xagent-verification.json contract', () => {
  test('both configured → 200 with schemaVersion/slug/commit', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = COMMIT;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = SLUG;
      const app = createApp({ uiEnabled: false });
      const res = await app.request('/.well-known/xagent-verification.json');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 1,
        slug: SLUG,
        commit: COMMIT,
      });
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });

  test('missing SOURCE_COMMIT → 404', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = undefined;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = SLUG;
      const app = createApp({ uiEnabled: false });
      const res = await app.request('/.well-known/xagent-verification.json');
      expect(res.status).toBe(404);
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });

  test('missing XAGT_VERIFICATION_SLUG → 404', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = COMMIT;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = undefined;
      const app = createApp({ uiEnabled: false });
      const res = await app.request('/.well-known/xagent-verification.json');
      expect(res.status).toBe(404);
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });

  test('neither configured → 404 (self-host zero impact)', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = undefined;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = undefined;
      const app = createApp({ uiEnabled: false });
      const res = await app.request('/.well-known/xagent-verification.json');
      expect(res.status).toBe(404);
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });

  test('is not swallowed by agentCard /.well-known mount', async () => {
    const prevCommit = config.sourceCommit;
    const prevSlug = config.xagtVerificationSlug;
    try {
      (config as { sourceCommit?: string }).sourceCommit = COMMIT;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = SLUG;
      const app = createApp({ uiEnabled: false });
      // agent-card 仍可达，证明前缀挂载未废；自证路径独立命中
      const card = await app.request('/.well-known/agent-card.json');
      expect(card.status).toBe(200);
      const xagt = await app.request('/.well-known/xagent-verification.json');
      expect(xagt.status).toBe(200);
      expect((await xagt.json() as { slug: string }).slug).toBe(SLUG);
    } finally {
      (config as { sourceCommit?: string }).sourceCommit = prevCommit;
      (config as { xagtVerificationSlug?: string }).xagtVerificationSlug = prevSlug;
    }
  });
});

describe('H1 Dockerfile/compose SOURCE_COMMIT plumbing', () => {
  const repoDir = join(import.meta.dir, '..', '..', '..');
  const dockerfile = readFileSync(join(repoDir, 'packages/api/Dockerfile'), 'utf8');
  const compose = readFileSync(join(repoDir, 'compose.yaml'), 'utf8');
  const composeApiOnly = readFileSync(join(repoDir, 'compose.api-only.yaml'), 'utf8');

  test('Dockerfile declares ARG SOURCE_COMMIT and ENV SOURCE_COMMIT', () => {
    expect(dockerfile).toMatch(/ARG SOURCE_COMMIT=/);
    expect(dockerfile).toMatch(/ENV SOURCE_COMMIT=\$SOURCE_COMMIT/);
  });

  test('compose.yaml and compose.api-only.yaml pass SOURCE_COMMIT build arg', () => {
    for (const src of [compose, composeApiOnly]) {
      expect(src).toMatch(/SOURCE_COMMIT:\s*\$\{SOURCE_COMMIT:-\}/);
      expect(src).toMatch(/XAGT_VERIFICATION_SLUG:\s*\$\{XAGT_VERIFICATION_SLUG:-\}/);
    }
  });
});
