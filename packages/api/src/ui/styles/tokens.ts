/**
 * 颜色/间距/字体变量与 Satoshi @font-face。
 * 内容维护在相邻真文件 tokens.css（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/styles.css 金标测试钉死。
 */
import { readFileSync } from 'node:fs';

export const TOKENS_CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
