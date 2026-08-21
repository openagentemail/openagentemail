/**
 * 定制空态：说明页面用途 + 可选下一步或文档链接。
 * 内容维护在相邻真文件 empty-state.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const EMPTY_STATE_JS = readFileSync(new URL('./empty-state.js', import.meta.url), 'utf8');
