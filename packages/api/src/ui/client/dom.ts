/**
 * 安全 DOM 查询与节点引用；禁止 innerHTML 拼用户数据。
 * 内容维护在相邻真文件 dom.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../load-ui-asset.ts';

export const DOM_JS = readUiSibling(import.meta.url, 'dom.js');
