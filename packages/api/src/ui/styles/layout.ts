/**
 * app shell、全局导航、侧栏与响应式层级。
 * 内容维护在相邻真文件 layout.css（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/styles.css 金标测试钉死。
 */
import { readUiSibling } from '../load-ui-asset.ts';

export const LAYOUT_CSS = readUiSibling(import.meta.url, 'layout.css');
