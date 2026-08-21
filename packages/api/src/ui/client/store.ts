/**
 * 跨页小型状态与渲染上限常量。
 * 内容维护在相邻真文件 store.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../load-ui-asset.ts';

export const STORE_JS = readUiSibling(import.meta.url, 'store.js');
