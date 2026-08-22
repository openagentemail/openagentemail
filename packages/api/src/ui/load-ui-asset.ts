import { existsSync, readFileSync } from 'node:fs';

/**
 * 启动时读入 UI 真文件（#520-A）。兼容两种磁盘布局：
 *
 *   源码树：真文件与 .ts 相邻（src/ui/**）——dev、test 与 Docker（COPY . .
 *           后直接 `bun run src/main.ts`）都走这条路径。
 *   dist：  `bun run build` 扁平打包成单一 dist/main.js，import.meta.url 在
 *           bundle 内解析到 dist/；构建脚本会把真文件按 <dist>/ui/<basename>
 *           拷出（19 个 .js + 4 个 .css 文件名全局唯一，可扁平存放）。
 *
 * 先试相邻布局，不存在再回落 ui/<name>；两处都缺才抛 ENOENT（与原先
 * 单布局行为一致：缺文件=启动即报错，不半死不活）。
 */

/** 扁平回落名只许安全字符（路径段自守，防未来传参变成穿越点）。 */
const SAFE_FLAT_NAME = /^[A-Za-z0-9._-]+$/;

/** 布局探测：先试相对模块的相邻路径，不存在再回落扁平 <moduleDir>/ui/<flatName>。 */
export function resolveUiAssetUrl(moduleUrl: string, siblingPath: string, flatName: string): URL {
  if (!SAFE_FLAT_NAME.test(flatName)) {
    throw new Error(`invalid flat asset name: ${JSON.stringify(flatName)}`);
  }
  const beside = new URL(siblingPath, moduleUrl);
  if (existsSync(beside)) return beside;
  return new URL(`./ui/${flatName}`, moduleUrl);
}

export function readUiSibling(moduleUrl: string, fileName: string): string {
  return readFileSync(resolveUiAssetUrl(moduleUrl, `./${fileName}`, fileName), 'utf8');
}
