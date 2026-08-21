/**
 * Tasks 工单面板。
 * 内容维护在相邻真文件 tasks.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../../load-ui-asset.ts';

export const TASKS_PAGE_JS = readUiSibling(import.meta.url, 'tasks.js');
