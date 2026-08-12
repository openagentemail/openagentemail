/**
 * UI 资产聚合出口：仅导出 OUTER_CSP / UI_HTML / UI_CSS / UI_JS / UI_LOGO_SVG。
 * 拆分边界是源码维护边界，不改变对外 /ui/styles.css 与 /ui/app.js 契约（ADR #26 PR1）。
 */
import { logoGeometry, SHELL_HTML } from './shell.ts';
import { TOKENS_CSS } from './styles/tokens.ts';
import { BASE_CSS } from './styles/base.ts';
import { LAYOUT_CSS } from './styles/layout.ts';
import { PAGES_CSS } from './styles/pages.ts';
import { STORE_JS } from './client/store.ts';
import { DOM_JS } from './client/dom.ts';
import { API_JS } from './client/api.ts';
import { ROUTER_JS } from './client/router.ts';
import { APP_NAV_JS } from './client/components/app-nav.ts';
import { IDENTITY_SWITCHER_JS } from './client/components/identity-switcher.ts';
import { EMPTY_STATE_JS } from './client/components/empty-state.ts';
import { MODAL_JS } from './client/components/modal.ts';
import { PAGINATOR_JS } from './client/components/paginator.ts';
import { SENSITIVE_CONTENT_JS } from './client/components/sensitive-content.ts';
import { INBOX_PAGE_JS } from './client/pages/inbox.ts';
import { OVERVIEW_PAGE_JS } from './client/pages/overview.ts';
import { NOTIFICATIONS_PAGE_JS } from './client/pages/notifications.ts';
import { TASKS_PAGE_JS } from './client/pages/tasks.ts';
import { IDENTITIES_PAGE_JS } from './client/pages/identities.ts';
import { PUSH_DEVICES_PAGE_JS } from './client/pages/push-devices.ts';
import { AUTHORIZED_CLIENTS_PAGE_JS } from './client/pages/authorized-clients.ts';
import { PLAN_PAGE_JS } from './client/pages/plan.ts';
import { APP_JS } from './client/app.ts';

// font-src 'self'：Satoshi 由 /ui/fonts/ 同源提供（见 routes/ui-assets.ts），不放行任何外源。
export const OUTER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** 唯一导出的 logo 常量：favicon 路由与"与官网文件逐字比对"的测试都只认它。 */
export const UI_LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n${logoGeometry}\n</svg>\n`;

export const UI_HTML = SHELL_HTML;

export const UI_CSS = TOKENS_CSS + BASE_CSS + LAYOUT_CSS + PAGES_CSS;

/** 浏览器端仍是 CSP script-src 'self' 下的 plain ES2019 IIFE；零 bundler。 */
export const UI_JS =
  '(function () {\n' +
  "  'use strict';\n\n" +
  STORE_JS +
  DOM_JS +
  API_JS +
  ROUTER_JS +
  APP_NAV_JS +
  IDENTITY_SWITCHER_JS +
  EMPTY_STATE_JS +
  MODAL_JS +
  PAGINATOR_JS +
  SENSITIVE_CONTENT_JS +
  INBOX_PAGE_JS +
  OVERVIEW_PAGE_JS +
  NOTIFICATIONS_PAGE_JS +
  TASKS_PAGE_JS +
  IDENTITIES_PAGE_JS +
  PUSH_DEVICES_PAGE_JS +
  AUTHORIZED_CLIENTS_PAGE_JS +
  PLAN_PAGE_JS +
  APP_JS +
  '})();';
