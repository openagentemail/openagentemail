/**
 * dist 产物冒烟（#520-A，Codex P1 修复的钉子）：`bun run build` 产物必须
 * 自包含可启动——UI 真文件（.js/.css）与字体已被 copy-ui-to-dist.ts 打进
 * dist/ui/，loader 在 bundle 内回落该目录。缺文件=模块加载即 ENOENT，本
 * 测试从真实进程 + 真实端口抓证据，防回归（含 Docker/发布完整性风险）。
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UI_JS, UI_CSS } = await import('../src/ui/assets.ts');
const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

const pkgDir = join(import.meta.dir, '..');
const dist = join(pkgDir, 'dist');

async function waitForServer(port: number, deadlineMs: number, getBootLog: () => string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > deadlineMs) throw new Error(`dist server did not come up; boot log:\n${getBootLog()}`);
    await Bun.sleep(200);
  }
}

describe('dist bundle is self-contained (#520-A)', () => {
  test('built dist/main.js serves byte-gold /ui/app.js, /ui/styles.css and fonts', async () => {
    rmSync(dist, { recursive: true, force: true });

    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: pkgDir });
    if (build.exitCode !== 0) throw new Error(`bun run build failed:\n${build.stderr}`);

    // dist/ui 清单：19 js + 4 css + 4 字体 = 27，且只有真资产（不带 .ts）。
    const distUi = readdirSync(join(dist, 'ui')).sort();
    expect(distUi).toEqual([
      ...[...readdirSync(join(pkgDir, 'src/ui/client')).filter((f) => f.endsWith('.js'))],
      ...readdirSync(join(pkgDir, 'src/ui/client/components')).filter((f) => f.endsWith('.js')),
      ...readdirSync(join(pkgDir, 'src/ui/client/pages')).filter((f) => f.endsWith('.js')),
      ...readdirSync(join(pkgDir, 'src/ui/styles')).filter((f) => f.endsWith('.css')),
      ...readdirSync(join(pkgDir, 'src/ui/fonts')),
    ].sort());

    const PORT = '39321';
    const child = spawn('bun', ['dist/main.js'], {
      cwd: pkgDir,
      env: {
        ...process.env,
        // 显式钉住：全量并发下其它测试可能把 UI_ENABLED 等改写进本进程 env。
        UI_ENABLED: 'true',
        PORT,
        DATA_DIR: join(pkgDir, 'test', '.tmp-dist-data'),
        NTFY_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    const onOut = (chunk: Buffer | string) => (bootLog += chunk);
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);

    try {
      await waitForServer(Number(PORT), 20000, () => bootLog);

      const js = await fetch(`http://127.0.0.1:${PORT}/ui/app.js`);
      expect(js.status).toBe(200);
      const css = await fetch(`http://127.0.0.1:${PORT}/ui/styles.css`);
      expect(css.status).toBe(200);
      const font = await fetch(`http://127.0.0.1:${PORT}/ui/fonts/Satoshi-Regular.woff2`);
      expect(font.status).toBe(200);
      await font.body?.cancel();

      expect(sha256(await js.text())).toBe(sha256(UI_JS));
      expect(sha256(await css.text())).toBe(sha256(UI_CSS));
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      rmSync(join(pkgDir, 'test', '.tmp-dist-data'), { recursive: true, force: true });
    }
  }, 60000);
});
