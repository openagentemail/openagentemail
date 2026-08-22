/**
 * reset、表单、可访问性、登录与通用控件。
 * 内容维护在相邻真文件 base.css（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/styles.css 金标测试钉死。
 */
import { readUiSibling } from '../load-ui-asset.ts';

export const BASE_CSS = readUiSibling(import.meta.url, 'base.css');
