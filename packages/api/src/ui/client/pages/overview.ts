/**
 * Overview 面板。
 * 内容维护在相邻真文件 overview.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const OVERVIEW_PAGE_JS = readFileSync(new URL('./overview.js', import.meta.url), 'utf8');
