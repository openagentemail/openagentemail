/**
 * 地址侧栏与移动 selector。
 * 内容维护在相邻真文件 identity-switcher.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const IDENTITY_SWITCHER_JS = readFileSync(new URL('./identity-switcher.js', import.meta.url), 'utf8');
