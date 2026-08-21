/**
 * Configure · Authorized Clients。
 * 内容维护在相邻真文件 authorized-clients.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../../load-ui-asset.ts';

export const AUTHORIZED_CLIENTS_PAGE_JS = readUiSibling(import.meta.url, 'authorized-clients.js');
