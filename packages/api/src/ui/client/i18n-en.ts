/**
 * #137 B1-A 机制件：壳层/connect 键槽所需 I18N_EN + 运行时（t/tFormat/fillI18nSlots/转义）。
 * 页面 call-site 迁移见 B1-B；本文件不含页面键全集。
 */
export const I18N_EN: Record<string, string> = {
  "api.action.readAMessage": "Read a message",
  "api.action.thisPaneShowsTheSelectedEmail": "This pane shows the selected email: codes and links first, then Rendered, Plain text, or Source. HTML stays in an isolated frame.",
  "app.action.copy": "Copy",
  "connect.action.loadingConnectionDetails": "Loading connection details…",
  "connect.action.reveal": "Reveal",
  "identities.copy.createIdentity": "Create Identity",
  "inbox.error.failed": "Failed",
  "login.remember": "Trust this device for 30 days",
  "login.submit": "Open Mail",
  "login.subtitle": "Paste an admin or identity API token. It is exchanged for a private, browser-only session cookie.",
  "login.title": "Your inbox, without the noise.",
  "login.tokenLabel": "API token",
  "modal.action.token": "Token",
  "modal.modal.confirm": "Confirm",
  "notifications.action.allChannels": "All channels",
  "notifications.action.channel": "Channel",
  "notifications.action.content": "Content",
  "notifications.action.level": "Level",
  "notifications.action.sendTest": "Send test",
  "notifications.action.when": "When",
  "notifications.copy.whatWeTriedToSendTo2": "What we tried to send to your phone and computers",
  "router.copy.skipToHome": "Skip to Home",
  "router.title.connectedApps": "Connected apps",
  "router.title.domains": "Domains",
  "router.title.identities": "Identities",
  "router.title.plan": "Plan",
  "router.title.pushDevices": "Push & Devices",
  "shell.a11y.closeNavigation": "Close navigation",
  "shell.a11y.dashboard": "Dashboard",
  "shell.a11y.domain": "Domain",
  "shell.a11y.inboxAddresses": "Inbox addresses",
  "shell.a11y.mailFolders": "Mail folders",
  "shell.a11y.pairingQrCode": "Pairing QR code",
  "shell.a11y.sortAddresses": "Sort addresses",
  "shell.a11y.taskDetail": "Task detail",
  "shell.a11y.taskList": "Task list",
  "shell.a11y.taskStatus": "Task status",
  "shell.html.account": "Account",
  "shell.html.actions": "Actions",
  "shell.html.active": "Active",
  "shell.html.addDevice": "Add device",
  "shell.html.addresses": "Addresses",
  "shell.html.all": "All",
  "shell.html.allAddressesU00b7CountsFromThe": "All addresses \\u00b7 counts from the newest 500 messages",
  "shell.html.allLevels": "All levels",
  "shell.html.backToFolders": "Back to folders",
  "shell.html.backToMessages": "Back to messages",
  "shell.html.backToTasks": "Back to tasks",
  "shell.html.cancel": "Cancel",
  "shell.html.chooseHowMuchOfAnIncoming": "Choose how much of an incoming message a push may include. Pair a phone for human alerts, then revoke it if the device is lost.",
  "shell.html.completed": "Completed",
  "shell.html.configuredMailDomainsForThisOpenagent": "Configured mail domains for this openagent.email instance.",
  "shell.html.connectAnAgent": "Connect an agent",
  "shell.html.connectionDetails": "Connection details",
  "shell.html.copyPassword": "Copy password",
  "shell.html.copyThisPasswordNowItWill": "Copy this password now. It will not be shown again.",
  "shell.html.copyThisTokenNowItWill": "Copy this token now. It will not be shown again.",
  "shell.html.copyToken": "Copy token",
  "shell.html.countsOverlapWhenOneEmailIs": "Counts overlap when one email is addressed to several addresses.",
  "shell.html.create": "Create",
  "shell.html.createCredentials": "Create credentials",
  "shell.html.customAddressOptional": "Custom address (optional)",
  "shell.html.deviceCredentials": "Device credentials",
  "shell.html.displayNameOptional": "Display name (optional)",
  "shell.html.done": "Done",
  "shell.html.filterAddresses": "Filter addresses",
  "shell.html.filterChannel": "Filter channel",
  "shell.html.folders": "Folders",
  "shell.html.formTokensNeverEnterTheAddress": "Form tokens never enter the address bar and are not stored by the page. Direct ?token= links are stripped on load, but may linger in browser history or server access logs.",
  "shell.html.from": "From",
  "shell.html.giveACodingAgentSecureAccess": "Give a coding agent secure access to this identity through the instance MCP endpoint.",
  "shell.html.giveThisPhoneANameYou": "Give this phone a name you will recognize later. The password is shown once.",
  "shell.html.identity": "Identity",
  "shell.html.identityToken": "Identity token",
  "shell.html.kitchenPhone": "Kitchen phone",
  "shell.html.last14Days": "Last 14 days",
  "shell.html.last24Hours": "Last 24 hours",
  "shell.html.last30Days": "Last 30 days",
  "shell.html.last7Days": "Last 7 days",
  "shell.html.leaveAddressBlankForARandom": "Leave address blank for a random one.",
  "shell.html.levelLow": "low",
  "shell.html.levelNormal": "normal",
  "shell.html.levelUrgent": "urgent",
  "shell.html.loadMore": "Load more",
  "shell.html.mcpEndpoint": "MCP endpoint",
  "shell.html.menu": "Menu",
  "shell.html.myBot": "My Bot",
  "shell.html.myBotPlaceholder": "my-bot",
  "shell.html.oauthGrantsForMcpClientsRevoking": "OAuth grants for MCP clients. Revoking deletes the grant and invalidates its tokens immediately.",
  "shell.html.oneKeyPerIdentityRotateShows": "One key per identity. Rotate shows the new key once; the old key is never shown again. Push tier is projected here and edited on Push & Devices.",
  "shell.html.pageSize": "Page size",
  "shell.html.pairedDevices": "Paired devices",
  "shell.html.perPage": "Per page",
  "shell.html.period": "Period",
  "shell.html.push": "Push",
  "shell.html.scanTheQrInNtfyOr": "Scan the QR in ntfy, or copy the server, username, and password below.",
  "shell.html.search": "Search",
  "shell.html.selectAMessageInTheList": "Select a message in the list to open it.",
  "shell.html.selfHostedInstancesDoNotBill": "Self-hosted instances do not bill from this dashboard.",
  "shell.html.settings": "Settings",
  "shell.html.signOut": "Sign out",
  "shell.html.taskTicketsRebuiltFromXOa": "Task tickets rebuilt from X-OA-Task mail threads",
  "shell.html.thisConnectionIsNotSecureOpen": "This connection is not secure. Open the inbox over HTTPS or an SSH tunnel before entering a token.",
  "shell.html.to": "To",
  "shell.html.treatThisTokenLikeAPassword": "Treat this token like a password. Do not paste it into chat, commit it, or share screenshots containing it.",
  "shell.html.u2190Home": "\\u2190 Home",
  "shell.html.work": "Work",
  "shell.nav.alerts": "Alerts",
  "shell.nav.home": "Home",
  "shell.nav.mail": "Mail",
  "shell.nav.tasks": "Tasks",
  "store.label.address": "Address",
  "store.label.created": "Created",
  "store.label.last": "Last",
  "store.label.messages": "Messages",
  "store.label.unseen": "Unseen",
  "tasks.action.chooseATicketToInspectIts": "Choose a ticket to inspect its state timeline and result.",
  "tasks.action.msgs": "Msgs",
  "tasks.action.participants": "Participants",
  "tasks.action.refresh": "Refresh",
  "tasks.action.state": "State",
  "tasks.action.subject": "Subject",
  "tasks.action.taskTicket": "Task ticket",
  "tasks.action.updated2": "Updated",
  "tasks.copy.waitingForYou": "Waiting for you",
  "tasks.detail.selectTask": "Select a task",
};

/** 序列化为浏览器 IIFE 内嵌字典字面量。 */
function embedDict(dict: Record<string, string>): string {
  return JSON.stringify(dict);
}

/** 自检锚点：取字典首键，确保嵌入后 t() 回落正确。 */
const I18N_SELF_CHECK_KEY = Object.keys(I18N_EN).sort()[0]!;
const I18N_SELF_CHECK_VAL = I18N_EN[I18N_SELF_CHECK_KEY]!;

/**
 * 拼入 UI_JS 的运行时件：t(key) + tFormat + 键集自检。
 * 解析序：window.OAE_I18N[key] → I18N_EN[key] → key。
 * 自检直查 I18N_EN，不经 t()/OAE_I18N——避免 B2 真字典注入后误抛。
 */
export const I18N_JS =
  '  var I18N_EN = ' +
  embedDict(I18N_EN) +
  ';\n' +
  '  function t(key) {\n' +
  '    return (window.OAE_I18N && window.OAE_I18N[key]) || I18N_EN[key] || key;\n' +
  '  }\n' +
  '  /** 带参模板：{name} 占位替换；缺省键清空。 */\n' +
  '  function tFormat(key, vars) {\n' +
  '    var s = t(key);\n' +
  '    if (!vars) return s;\n' +
  "    return s.replace(/\\{(\\w+)\\}/g, function (_m, name) {\n" +
  '      return vars[name] != null ? String(vars[name]) : "";\n' +
  '    });\n' +
  '  }\n' +
  '  // 键集自检：字典非空，且内嵌 I18N_EN 首键值自洽（不经 t/OAE_I18N）。\n' +
  '  if (Object.keys(I18N_EN).length < 1) {\n' +
  "    throw new Error('i18n_en_empty');\n" +
  '  }\n' +
  '  if (I18N_EN[' +
  JSON.stringify(I18N_SELF_CHECK_KEY) +
  '] !== ' +
  JSON.stringify(I18N_SELF_CHECK_VAL) +
  ') {\n' +
  "    throw new Error('i18n_en_lookup_failed');\n" +
  '  }\n\n';

/**
 * 服务端 t：优先可选 locale 字典，缺省回落 I18N_EN。
 */
export function tServer(key: string, dict?: Record<string, string>): string {
  if (dict && Object.prototype.hasOwnProperty.call(dict, key)) {
    return dict[key]!;
  }
  return I18N_EN[key] || key;
}

/**
 * 解码字典中的 \\uXXXX 字面转义为真实字符（不做 HTML 编码）。
 */
function decodeUnicodeEscapes(raw: string): string {
  if (!raw.includes('\\u')) return raw;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * HTML 文本位转义：& < > 一律编码（弃「已含实体则跳过」）。
 */
export function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * HTML 属性位转义：在文本转义基础上再编码 " '，防属性 breakout。
 */
export function escapeHtmlAttr(raw: string): string {
  return escapeHtmlText(raw).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 键槽模板填充：仅替换 {{key}}；按上下文选文本位/属性位转义。
 * dict 缺省或缺键时回落 I18N_EN。
 */
export function fillI18nSlots(
  template: string,
  dict?: Record<string, string>,
): string {
  return template.replace(/\{\{([\w.-]+)\}\}/g, (_m, key: string, offset: number) => {
    const raw =
      dict && Object.prototype.hasOwnProperty.call(dict, key)
        ? dict[key]!
        : I18N_EN[key] || key;
    const decoded = decodeUnicodeEscapes(raw);
    // 属性位：紧邻 =" 或 ='（placeholder="{{k}}" / aria-label="{{k}}"）
    const before = template.slice(Math.max(0, offset - 2), offset);
    const inAttr = before === '="' || before === "='";
    return inAttr ? escapeHtmlAttr(decoded) : escapeHtmlText(decoded);
  });
}

/** 字典件响应体：B1 骨架为空对象（真译文 B2）。 */
export function i18nLocaleScript(_locale: string): string {
  return 'window.OAE_I18N = {};\n';
}
