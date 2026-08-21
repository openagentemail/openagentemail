/**
 * Notifications 面板。
 * 内容维护在相邻真文件 notifications.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const NOTIFICATIONS_PAGE_JS = readFileSync(new URL('./notifications.js', import.meta.url), 'utf8');
