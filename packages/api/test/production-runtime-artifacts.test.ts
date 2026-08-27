import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { expect, test } = await import('bun:test');

const pkgDir = join(import.meta.dir, '..');
const repoDir = join(pkgDir, '..', '..');

test('#91 R1 RED: canonical runtime bundle carries the ntfy provisioner and every Compose command targets dist', () => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: pkgDir });
  expect(build.exitCode).toBe(0);

  const provisioner = join(pkgDir, 'dist', 'ntfy-provision.js');
  expect(existsSync(provisioner)).toBe(true);

  for (const composeName of ['compose.yaml', 'compose.api-only.yaml']) {
    const compose = readFileSync(join(repoDir, composeName), 'utf8');
    if (!compose.includes('ntfy-provision:')) continue;
    expect(compose).toContain('command: ["bun", "dist/ntfy-provision.js"]');
  }

  const runtimeStage = readFileSync(join(pkgDir, 'Dockerfile'), 'utf8').split('FROM oven/bun:1 AS runtime', 2)[1]!;
  expect(runtimeStage).toContain('COPY --from=build /app/dist ./dist');
  expect(runtimeStage).not.toContain('src/');
  expect(runtimeStage).not.toContain('test/');
});
