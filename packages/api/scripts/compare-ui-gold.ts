/**
 * UI 资产金标比对：把本分支 assets.ts 产出的 UI_JS / UI_CSS 与指定 ref
 * （默认 origin/main）逐字节比对。比对走两条通道：
 *   1. 模块导出：直接 import 两边树的 src/ui/assets.ts；
 *   2. HTTP 响应体：createApp({ uiEnabled: true }) 后 app.request('/ui/app.js' | '/ui/styles.css')。
 * 共 4 对 Buffer，全部逐字节相等才 PASS（退出码 0）。
 *
 * 用法：bun run scripts/compare-ui-gold.ts [--ref <ref>]
 * 依赖 git（临时 worktree）与本机 bun；金标树会按锁文件装依赖后即弃。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
let ref = 'origin/main';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref' && args[i + 1]) ref = args[i + 1];
}
// ref 会传给 git rev-parse / worktree add：只放行"分支名点线"或完整/短 SHA，
// 拒绝以 - 开头的值被 git 当选项解析（ZCode P2 建议）。
if (!/^[\w][\w./-]*$/.test(ref) || ref.startsWith('-')) {
  throw new Error(`invalid --ref value: ${ref}`);
}

function sh(cwd: string, cmd: string[]): string {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const repoRoot = sh(process.cwd(), ['git', 'rev-parse', '--show-toplevel']);
const apiDir = join(repoRoot, 'packages', 'api');
const goldSha = sh(repoRoot, ['git', 'rev-parse', '--verify', ref]);
console.log(`gold ref: ${ref} = ${goldSha}`);
console.log(`branch HEAD = ${sh(repoRoot, ['git', 'rev-parse', 'HEAD'])}`);

// 求值脚本：在目标树的 packages/api 下运行，从 env 拿输出目录与资产路径。
const dump = `
const out = process.env.UI_GOLD_OUT!;
const envs = {
  DOMAIN: 'test.example',
  API_KEYS: 'admin-key',
  IMAP_USER: 'agent@test.example',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'agent@test.example',
  SMTP_PASS: 'smtp-secret',
};
for (const [k, v] of Object.entries(envs)) process.env[k] = v;
const { UI_JS, UI_CSS } = await import(process.env.UI_ASSETS_PATH!);
await Bun.write(out + '/app.js.export', Buffer.from(UI_JS, 'utf8'));
await Bun.write(out + '/styles.css.export', Buffer.from(UI_CSS, 'utf8'));
const { createApp } = await import(process.env.UI_APP_PATH!);
const app = createApp({ uiEnabled: true });
const js = await app.request('/ui/app.js');
const css = await app.request('/ui/styles.css');
if (js.status !== 200 || css.status !== 200) throw new Error('asset route not 200');
await Bun.write(out + '/app.js.http', Buffer.from(await js.text(), 'utf8'));
await Bun.write(out + '/styles.css.http', Buffer.from(await css.text(), 'utf8'));
`;

const workDir = mkdtempSync(join(tmpdir(), 'ui-gold-'));
writeFileSync(join(workDir, 'dump.ts'), dump);
const goldTree = join(workDir, 'gold');
const goldOut = join(workDir, 'gold-out');
const branchOut = join(workDir, 'branch-out');
let exitCode = 0;

try {
  sh(repoRoot, ['git', 'worktree', 'add', '--detach', goldTree, ref]);
  // 金标树按锁文件装依赖（createApp 需要 hono/zod 等）；本树已具备依赖。
  sh(join(goldTree, 'packages', 'api'), ['bun', 'install', '--frozen-lockfile']);

  // 在两棵树的 packages/api 下各跑一次 dump，路径经 env 传入，避免引号问题。
  for (const [tree, out, assets, app] of [
    [goldTree, goldOut, join(goldTree, 'packages/api/src/ui/assets.ts'), join(goldTree, 'packages/api/src/app.ts')],
    [repoRoot, branchOut, join(apiDir, 'src/ui/assets.ts'), join(apiDir, 'src/app.ts')],
  ] as const) {
    const r = spawnSync('bun', [join(workDir, 'dump.ts')], {
      cwd: join(tree, 'packages', 'api'),
      encoding: 'utf8',
      env: { ...process.env, UI_GOLD_OUT: out, UI_ASSETS_PATH: assets, UI_APP_PATH: app },
    });
    if (r.status !== 0) throw new Error(`dump failed in ${tree}:\n${r.stderr || r.stdout}`);
  }

  const sha256 = (buf: Buffer) => new Bun.CryptoHasher('sha256').update(buf).digest('hex');
  for (const name of ['app.js.export', 'styles.css.export', 'app.js.http', 'styles.css.http']) {
    const gold = readFileSync(join(goldOut, name));
    const branch = readFileSync(join(branchOut, name));
    const equal = gold.equals(branch);
    if (!equal) exitCode = 1;
    console.log(
      `${equal ? 'PASS' : 'FAIL'}  ${name.padEnd(17)} gold ${gold.length}B ${sha256(gold).slice(0, 16)}…  branch ${branch.length}B ${sha256(branch).slice(0, 16)}…`,
    );
  }
  if (exitCode === 0) console.log('ALL BYTE-IDENTICAL vs ' + ref);
  else console.log('MISMATCH — see pairs above');
} finally {
  try {
    sh(repoRoot, ['git', 'worktree', 'remove', '--force', goldTree]);
  } catch {
    /* 尽力清理 */
  }
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
