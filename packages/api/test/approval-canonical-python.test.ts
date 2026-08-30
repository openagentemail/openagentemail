import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('public v1 corpus passes the independent Python verifier', () => {
  const python3 = Bun.which('python3');
  if (!python3) throw new Error('Python 3 is required for the approval canonical-vector verifier; install Python 3 and ensure python3 is on PATH.');
  const verification = Bun.spawnSync({
    cmd: [python3, fileURLToPath(new URL('../scripts/verify-approval-canonical-vectors.py', import.meta.url))],
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(verification.exitCode).toBe(0);
  expect(new TextDecoder().decode(verification.stdout)).toContain('verified 4 public v1 vectors');
});
