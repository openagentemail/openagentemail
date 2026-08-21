/**
 * 全局导航抽屉与当前页高亮。
 * 内容维护在相邻真文件 app-nav.js（ESLint 管辖）；本模块仅启动时读入，
 * 拼接产物字节由 /ui/app.js 金标测试钉死。
 */
import { readUiSibling } from '../../load-ui-asset.ts';

export const APP_NAV_JS = readUiSibling(import.meta.url, 'app-nav.js');
