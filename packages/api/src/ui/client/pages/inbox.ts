/**
 * Inbox 列表/详情与会话内消息操作。
 * 内容维护在相邻真文件 inbox.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../../load-ui-asset.ts';

export const INBOX_PAGE_JS = readUiSibling(import.meta.url, 'inbox.js');
