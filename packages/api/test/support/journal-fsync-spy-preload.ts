import { mock } from 'bun:test';
const actual = await import('node:fs');
const realOpenSync = actual.openSync;
const realFsyncSync = actual.fsyncSync;
const realWriteFileSync = actual.writeFileSync;
const log: Array<Record<string, unknown>> = [];
const fdPaths = new Map<number, string>();
mock.module('node:fs', () => ({
  ...actual,
  openSync: ((p: string, flags?: unknown, mode?: unknown) => {
    const fd = (realOpenSync as (...a: unknown[]) => number)(p, flags, mode);
    fdPaths.set(fd, String(p));
    log.push({ op: 'open', fd, path: String(p) });
    return fd;
  }) as typeof realOpenSync,
  fsyncSync: (fd: number) => {
    const r = realFsyncSync(fd);
    log.push({ op: 'fsync', fd, path: fdPaths.get(fd) ?? null });
    return r;
  },
}));
process.on('exit', () => {
  const out = process.env.OAE_FS_SPY_LOG;
  if (out) realWriteFileSync(out, JSON.stringify(log));
});
