import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('webhook signature vectors pass the independent Python verifier (§14 item 1)', () => {
  const python3 = Bun.which('python3');
  if (!python3) {
    throw new Error('Python 3 is required for the webhook signature vector verifier');
  }
  const verification = Bun.spawnSync({
    cmd: [
      python3,
      fileURLToPath(new URL('../scripts/verify-webhook-signature-vectors.py', import.meta.url)),
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(verification.exitCode).toBe(0);
  expect(new TextDecoder().decode(verification.stdout)).toContain(
    'verified 4 public v1 webhook signature vectors',
  );
});
