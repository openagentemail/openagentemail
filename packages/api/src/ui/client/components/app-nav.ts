/**
 * 全局导航抽屉与当前页高亮。
 * 内容维护在相邻真文件 app-nav.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const APP_NAV_JS = readFileSync(new URL('./app-nav.js', import.meta.url), 'utf8');
