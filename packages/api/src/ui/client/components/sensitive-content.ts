/**
 * 敏感内容遮蔽（PR3）。
 * 内容维护在相邻真文件 sensitive-content.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const SENSITIVE_CONTENT_JS = readFileSync(new URL('./sensitive-content.js', import.meta.url), 'utf8');
