/**
 * 本地真扫码：生成配对 payload QR PNG，用 OpenCV QRCodeDetector 解码。
 * 用法：QR_DECODE_PYTHON=/path/to/python bun scripts/verify-pairing-qr.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeQrModules } from '../src/lib/qr-byte.ts';
import { qrModulesToPng } from '../src/lib/qr-png.ts';

const PAIRING_JSON = JSON.stringify({
  serverUrl: 'https://notify.test.example',
  username: 'phone-abcdefgh',
  password: 'abcdefghijklmnopqrstuvwx',
  topics: { userAlerts: 'user-alerts-xyzxyzxyz', userLow: 'user-low-xyzxyzxyz' },
});

function decoderPython(): string | null {
  if (process.env.QR_DECODE_PYTHON) return process.env.QR_DECODE_PYTHON;
  for (const candidate of ['/tmp/oae-qr-venv/bin/python', 'python3']) {
    const probe = Bun.spawnSync([candidate, '-c', 'import cv2; cv2.QRCodeDetector()'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (probe.exitCode === 0) return candidate;
  }
  return null;
}

const encoded = encodeQrModules(PAIRING_JSON);
const png = qrModulesToPng(encoded.size, encoded.modules, { scale: 8, quiet: 4 });
const dir = mkdtempSync(join(tmpdir(), 'oae-qr-'));
const pngPath = join(dir, 'pairing.png');
writeFileSync(pngPath, png);

const py = decoderPython();
if (!py) {
  console.error('no OpenCV decoder (set QR_DECODE_PYTHON)');
  process.exit(2);
}

const script = join(import.meta.dir, 'decode-pairing-qr.py');
const result = Bun.spawnSync([py, script, pngPath], { stdout: 'pipe', stderr: 'pipe' });
const out = result.stdout.toString();
const err = result.stderr.toString();
console.log(`png=${pngPath}`);
console.log(`size=${encoded.size} bytes=${png.length}`);
console.log(`decoder=${py} exit=${result.exitCode}`);
if (err.trim()) console.log(`stderr=${err.trim()}`);
console.log(`decoded=${out.trim()}`);
if (result.exitCode !== 0 || out.trim() !== PAIRING_JSON) {
  console.error('MISMATCH: decoded payload != original pairing JSON');
  process.exit(1);
}
console.log('OK pairing payload round-trip');
