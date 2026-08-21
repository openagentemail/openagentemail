/**
 * /ui 路径解析、History/Back、applyScope 与 ACL fallback。
 * 内容维护在相邻真文件 router.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const ROUTER_JS = readFileSync(new URL('./router.js', import.meta.url), 'utf8');
