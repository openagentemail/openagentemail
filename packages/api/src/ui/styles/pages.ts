/**
 * 各页面样式的显式汇总。
 * 内容维护在相邻真文件 pages.css（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/styles.css 金标测试钉死。
 */
import { readUiSibling } from '../load-ui-asset.ts';

export const PAGES_CSS = readUiSibling(import.meta.url, 'pages.css');
