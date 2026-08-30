import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
test('stale publication artifacts fail the explicit and prepack checks without touching the worktree', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'oae-approval-publication-'));
  try {
    for (const path of ['docs', 'packages/api/scripts', 'packages/api/test/fixtures', 'packages/mcp']) {
      mkdirSync(join(fixtureRoot, path), { recursive: true });
    }
    copyFileSync(join(repositoryRoot, 'docs/approval-digest.md'), join(fixtureRoot, 'docs/approval-digest.md'));
    copyFileSync(join(repositoryRoot, 'packages/api/test/fixtures/approval-canonical-vectors.v1.json'), join(fixtureRoot, 'packages/api/test/fixtures/approval-canonical-vectors.v1.json'));
    copyFileSync(join(repositoryRoot, 'packages/api/scripts/sync-approval-publication.mjs'), join(fixtureRoot, 'packages/api/scripts/sync-approval-publication.mjs'));
    copyFileSync(join(repositoryRoot, 'packages/mcp/package.json'), join(fixtureRoot, 'packages/mcp/package.json'));
    writeFileSync(join(fixtureRoot, 'packages/mcp/approval-digest.md'), 'stale artifact\n');
    copyFileSync(join(repositoryRoot, 'packages/mcp/approval-canonical-vectors.v1.json'), join(fixtureRoot, 'packages/mcp/approval-canonical-vectors.v1.json'));
    const fixtureSyncScript = join(fixtureRoot, 'packages/api/scripts/sync-approval-publication.mjs');
    const adversarialEnv = { ...process.env, APPROVAL_PUBLICATION_ROOT: repositoryRoot };
    const explicitCheck = Bun.spawnSync({ cmd: ['node', fixtureSyncScript, '--check'], env: adversarialEnv, stdout: 'pipe', stderr: 'pipe' });
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'packages/mcp/package.json'), 'utf8')) as { scripts: { prepack: string } };
    const prepackCheck = Bun.spawnSync({
      cmd: ['npm', 'run', 'prepack'], cwd: join(fixtureRoot, 'packages/mcp'), env: adversarialEnv, stdout: 'pipe', stderr: 'pipe',
    });
    expect(packageJson.scripts.prepack).toBe('node ../api/scripts/sync-approval-publication.mjs --check');
    expect(explicitCheck.exitCode).toBe(1);
    expect(prepackCheck.exitCode).toBe(1);
    expect(readFileSync(join(fixtureRoot, 'packages/mcp/approval-digest.md'), 'utf8')).toBe('stale artifact\n');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
