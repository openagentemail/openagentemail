import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.TASK_LEASES_ENABLED = 'true';

const { expect, test } = await import('bun:test');

test('#89 RED: production lease modules expose neither signing/parser helpers nor gate overrides', async () => {
  const tasks = await import('../src/lib/tasks.ts');
  expect(Object.hasOwn(tasks, 'claimLeaseHeadersForTests')).toBe(false);
  expect(Object.hasOwn(tasks, 'parseTaskMessageForTests')).toBe(false);
  expect(Object.hasOwn(tasks, 'setTaskLeasesEnabledForTests')).toBe(false);
  expect(Object.hasOwn(tasks, 'withTaskLeasesEnabledForTests')).toBe(false);
  expect(Object.hasOwn(tasks, 'parseStampedTaskMessageForTests')).toBe(false);
  for (const path of ['../src/lib/tasks.ts', '../src/routes/tasks.ts', '../src/lib/task-lease-reaper.ts', '../src/app.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).not.toContain('leaseEnabledForTests');
    expect(source).not.toContain('setTaskLeasesEnabledForTests');
    expect(source).not.toContain('withTaskLeasesEnabledForTests');
    expect(source).not.toContain('taskLeaseTestRegistry');
  }
});

test('#92: production task facade and bundle exclude dependency-injection test seams', async () => {
  const tasks = await import('../src/lib/tasks.ts');
  const taskSeams = [
    'setTaskNowForTests',
    'setTaskListAllForTests',
    'setTaskGetForTests',
    'setTaskSendMailForTests',
    'clearQueuedEventsForTests',
  ];
  for (const seam of taskSeams) {
    expect(Object.hasOwn(tasks, seam)).toBe(false);
  }

  const tasksSource = readFileSync(new URL('../src/lib/tasks.ts', import.meta.url), 'utf8');
  for (const seam of taskSeams) {
    expect(tasksSource).not.toContain(seam);
  }

  const support = await import('./support/task-test-seams.ts');
  for (const seam of taskSeams) {
    expect(typeof (support as Record<string, unknown>)[seam]).toBe('function');
  }
});

test('#89 / #92 GREEN: canonical production bundle and final Docker stage exclude every test seam', () => {
  const pkgDir = join(import.meta.dir, '..');
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: pkgDir });
  expect(build.exitCode).toBe(0);
  const bundle = readFileSync(join(pkgDir, 'dist', 'main.js'), 'utf8');
  for (const seam of [
    'claimLeaseHeadersForTests',
    'parseTaskMessageForTests',
    'setTaskLeasesEnabledForTests',
    'withTaskLeasesEnabledForTests',
    'parseStampedTaskMessageForTests',
    'taskLeaseTestRegistry',
    'setTaskNowForTests',
    'setTaskListAllForTests',
    'setTaskGetForTests',
    'setTaskSendMailForTests',
    'clearQueuedEventsForTests',
  ]) expect(bundle).not.toContain(seam);

  const runtimeStage = readFileSync(join(pkgDir, 'Dockerfile'), 'utf8').split('FROM oven/bun:1 AS runtime', 2)[1]!;
  const runtimeCopies = [...runtimeStage.matchAll(/^COPY\s+--from=(\S+)\s+(\S+)\s+(\S+)\s*$/gm)]
    .map(([, stage, source, destination]) => [stage, source, destination]);
  // This is an image-stage proof independent of an installed Docker daemon:
  // the final stage has exactly these two artifacts, never the build context.
  expect(runtimeCopies).toEqual([
    ['production-deps', '/app/node_modules', './node_modules'],
    ['build', '/app/dist', './dist'],
  ]);
  expect(runtimeStage).not.toMatch(/^ADD\s+/m);
  expect(runtimeStage).not.toContain('COPY . .');
  expect(runtimeStage).not.toContain('src/');
  expect(runtimeStage).not.toContain('test/');
  expect(runtimeStage).toContain('CMD ["bun", "dist/main.js"]');
});
