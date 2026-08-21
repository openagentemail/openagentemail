/**
 * 安全 DOM 查询与节点引用；禁止 innerHTML 拼用户数据。
 * 内容维护在相邻真文件 dom.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const DOM_JS = readFileSync(new URL('./dom.js', import.meta.url), 'utf8');
