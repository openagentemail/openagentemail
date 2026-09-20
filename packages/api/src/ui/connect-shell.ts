/** Connect 页壳片段：键槽模板 + 结构化地标注入（与 locale 文案解耦）。 */
import { fillI18nSlots } from "./client/i18n-en.ts";

const CONNECT_NAV_TEMPLATE = "            <li><a class=\"app-nav-link\" data-nav=\"connect\" href=\"/ui/connect\">{{shell.html.connectAnAgent}}</a></li>\n";
const CONNECT_PANEL_TEMPLATE = "      <main id=\"connect-panel\" class=\"configure-panel connect-panel\" tabindex=\"-1\" aria-labelledby=\"connect-title\" hidden>\n        <div class=\"panel-heading overview-heading\">\n          <div>\n            <h2 id=\"connect-title\">{{shell.html.connectAnAgent}}</h2>\n            <p class=\"overview-subtitle\">{{shell.html.giveACodingAgentSecureAccess}}</p>\n          </div>\n        </div>\n        <section id=\"connect-credential\" class=\"connect-credential\" aria-labelledby=\"connect-credential-title\" hidden>\n          <h3 id=\"connect-credential-title\">{{shell.html.connectionDetails}}</h3>\n          <dl class=\"connect-details\">\n            <div><dt>{{shell.html.identity}}</dt><dd id=\"connect-identity\"></dd></div>\n            <div><dt>{{shell.html.mcpEndpoint}}</dt><dd><code id=\"connect-endpoint\"></code></dd></div>\n            <div><dt>{{shell.html.identityToken}}</dt><dd class=\"connect-token-row\"><code id=\"connect-token\">••••••••••••</code><button id=\"connect-token-reveal\" class=\"quiet\" type=\"button\" aria-pressed=\"false\">{{connect.action.reveal}}</button><button id=\"connect-token-copy\" class=\"quiet\" type=\"button\">{{shell.html.copyToken}}</button></dd></div>\n          </dl>\n          <p class=\"fine-print\">{{shell.html.treatThisTokenLikeAPassword}}</p>\n        </section>\n        <p id=\"connect-state\" class=\"empty-state\">{{connect.action.loadingConnectionDetails}}</p>\n        <div id=\"connect-cards\" class=\"connect-cards\"></div>\n      </main>\n\n";

/** 填充 connect 导航；dict 缺省回落 I18N_EN。 */
export function connectNavHtml(dict?: Record<string, string>): string {
  return fillI18nSlots(CONNECT_NAV_TEMPLATE, dict);
}

/** 填充 connect 面板。 */
export function connectPanelHtml(dict?: Record<string, string>): string {
  return fillI18nSlots(CONNECT_PANEL_TEMPLATE, dict);
}

/**
 * 把 Connect 页注入 dashboard shell。
 * 地标用 data-nav / id（不依赖译文），避免非 en 填充后找不到插入点。
 */
export function withConnectShell(
  shell: string,
  dict?: Record<string, string>,
): string {
  const nav = connectNavHtml(dict);
  const panel = connectPanelHtml(dict);
  // 地标固定缩进 + data-nav/id；不吞前导换行（保 en 逐字节）。
  const navRe =
    /(            <li><a class="app-nav-link" data-nav="configure-clients" href="\/ui\/configure\/clients">[\s\S]*?<\/a><\/li>\n)/;
  const panelRe =
    /(      <main id="configure-identities-panel" class="configure-panel"[^>]*>)/;
  if (!navRe.test(shell) || !panelRe.test(shell)) {
    throw new Error("connect_shell_landmark_missing");
  }
  navRe.lastIndex = 0;
  panelRe.lastIndex = 0;
  // 回调插入：译文含 $ / $& / $$ / $1 时一律字面，杜绝 String.replace 替换语义。
  return shell
    .replace(navRe, (_m, p1: string) => p1 + nav)
    .replace(panelRe, (_m, p1: string) => panel + p1);
}
