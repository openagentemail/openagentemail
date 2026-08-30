import { expect, test } from 'bun:test';

test('public v1 corpus passes the independent Python verifier', () => {
  const verification = Bun.spawnSync({
    cmd: ['python3', new URL('../scripts/verify-approval-canonical-vectors.py', import.meta.url).pathname],
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(verification.exitCode).toBe(0);
  expect(new TextDecoder().decode(verification.stdout)).toContain('verified 4 public v1 vectors');
});
