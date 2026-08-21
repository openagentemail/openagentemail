/**
 * 启动、登录门闸、全局事件与错误边界。
 * 内容维护在相邻真文件 app.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../load-ui-asset.ts';

export const APP_JS = readUiSibling(import.meta.url, 'app.js');
