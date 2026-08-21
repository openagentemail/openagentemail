/**
 * build 后处理：把 UI 真文件拷进 dist（#520-A）。
 *
 * `bun build --outdir dist` 只产出扁平 dist/main.js；loader 在 bundle 内按
 * import.meta.url 解析（dist/），相邻真文件不在那里。本脚本把 19 个 .js +
 * 4 个 .css 真文件与 4 个字体按 dist/ui/<name> 扁平拷出（文件名全局唯一）。
 * test/dist-bundle.test.ts 会起真实 dist 进程钉住 /ui 资产路由可用。
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcUi = join(here, '..', 'src', 'ui');
const distUi = join(here, '..', 'dist', 'ui');

mkdirSync(distUi, { recursive: true });
for (const dir of ['client', 'client/components', 'client/pages', 'styles', 'fonts']) {
  // 只拷真资产（.js/.css/.woff2），不带 .ts loader；文件名全局唯一，直接打平。
  for (const name of readdirSync(join(srcUi, dir))) {
    const ext = extname(name);
    if (ext === '.js' || ext === '.css' || ext === '.woff2') {
      copyFileSync(join(srcUi, dir, name), join(distUi, name));
    }
  }
}
