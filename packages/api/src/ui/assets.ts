export const OUTER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'self'; object-src 'none'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>OpenAgent Inbox</title>
  <link rel="icon" href="/ui/favicon.ico">
  <link rel="stylesheet" href="/ui/styles.css">
  <script src="/ui/app.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to inbox</a>

  <main id="login-view" class="login-view">
    <section class="login-card" aria-labelledby="login-title">
      <div class="brand-mark" aria-hidden="true">OA</div>
      <p class="eyebrow">OpenAgent.email</p>
      <h1 id="login-title">Your inbox, without the noise.</h1>
      <p class="muted">Paste an admin or identity API token. It is exchanged for a private, browser-only session cookie.</p>
      <form id="login-form">
        <label for="login-token">API token</label>
        <input id="login-token" name="credential" type="password" autocomplete="current-password" maxlength="512" required>
        <button id="login-submit" class="primary" type="submit">Open inbox</button>
      </form>
      <p id="insecure-warning" class="notice warning" hidden>This connection is not secure. Open the inbox over HTTPS or an SSH tunnel before entering a token.</p>
      <p id="login-error" class="notice error" aria-live="polite"></p>
      <p class="fine-print">The token never enters the address bar and is not stored by the page.</p>
    </section>
  </main>

  <section id="inbox-view" class="inbox-view" data-mobile-view="list" hidden>
    <header class="topbar">
      <div>
        <p class="eyebrow">OpenAgent.email</p>
        <h1>Inbox</h1>
      </div>
      <div class="topbar-actions">
        <span id="session-label" class="session-label"></span>
        <button id="logout-button" class="quiet" type="button">Sign out</button>
      </div>
    </header>

    <div class="inbox-layout">
      <aside class="identity-panel" aria-labelledby="identities-title">
        <div class="panel-heading">
          <h2 id="identities-title">Addresses</h2>
          <span id="identity-count" class="count"></span>
        </div>
        <label class="search-label" for="identity-search">Filter addresses</label>
        <input id="identity-search" class="search-input" type="search" placeholder="Search" autocomplete="off">
        <nav aria-label="Inbox addresses">
          <ul id="identity-list" class="identity-list"></ul>
        </nav>
      </aside>

      <section class="message-panel" aria-labelledby="messages-title">
        <div class="panel-heading message-heading">
          <div>
            <p id="active-address" class="active-address"></p>
            <h2 id="messages-title">Messages</h2>
          </div>
          <button id="refresh-button" class="quiet" type="button">Refresh</button>
        </div>
        <div class="mobile-identity">
          <label for="mobile-identity-select">Address</label>
          <select id="mobile-identity-select"></select>
        </div>
        <div id="message-state" class="empty-state"></div>
        <ol id="message-list" class="message-list"></ol>
      </section>

      <main id="main-content" class="detail-panel" tabindex="-1">
        <button id="mobile-back" class="quiet mobile-back" type="button">Back to messages</button>
        <div id="detail-content" class="detail-content">
          <div class="detail-placeholder">
            <p class="eyebrow">Message preview</p>
            <h2>Select a message</h2>
            <p class="muted">Choose a message to read its plain text, codes, links, or isolated HTML preview.</p>
          </div>
        </div>
      </main>
    </div>
  </section>

  <div id="status" class="sr-only" aria-live="polite"></div>
</body>
</html>`;

export const UI_CSS = `:root {
  color-scheme: dark;
  --bg: #0c0d12;
  --panel: #12141b;
  --panel-2: #171a23;
  --line: #2a2e3a;
  --text: #f5f5f4;
  --muted: #a4a7b2;
  --amber: #fbbf24;
  --amber-soft: #3b2d0b;
  --danger: #fca5a5;
  --radius: 14px;
}

* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input, select { font: inherit; }
button, select { cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
  outline: 3px solid var(--amber);
  outline-offset: 2px;
}
[hidden] { display: none !important; }
.skip-link {
  position: fixed;
  left: 12px;
  top: -60px;
  z-index: 20;
  background: var(--amber);
  color: #18120a;
  padding: 9px 14px;
  border-radius: 8px;
}
.skip-link:focus { top: 12px; }
.eyebrow {
  margin: 0 0 5px;
  color: var(--amber);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.muted { color: var(--muted); }
.login-view {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 20% 15%, rgba(251, 191, 36, .09), transparent 30%),
    var(--bg);
}
.login-card {
  width: min(100%, 460px);
  padding: 38px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: rgba(18, 20, 27, .96);
  box-shadow: 0 26px 80px rgba(0, 0, 0, .32);
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 24px;
  border-radius: 12px;
  background: var(--amber);
  color: #17120a;
  font-weight: 900;
}
.login-card h1 { margin: 0; font-size: clamp(28px, 6vw, 40px); line-height: 1.08; }
.login-card form { display: grid; gap: 9px; margin-top: 28px; }
label { color: #d6d7dc; font-size: 13px; font-weight: 700; }
input, select {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #0d0f15;
  color: var(--text);
  padding: 10px 12px;
}
button {
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel-2);
  color: var(--text);
  padding: 8px 13px;
}
button:hover { border-color: #555b6b; }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary {
  margin-top: 7px;
  border-color: var(--amber);
  background: var(--amber);
  color: #18120a;
  font-weight: 800;
}
.quiet { background: transparent; }
.notice { min-height: 1.5em; margin: 13px 0 0; }
.notice.error { color: var(--danger); }
.notice.warning {
  padding: 10px 12px;
  border: 1px solid #7c5b15;
  border-radius: 9px;
  background: var(--amber-soft);
  color: #fde68a;
}
.fine-print { margin: 20px 0 0; color: #7f8390; font-size: 12px; }
.inbox-view { min-height: 100vh; }
.topbar {
  height: 74px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 22px;
  border-bottom: 1px solid var(--line);
  background: #0e1016;
}
.topbar h1 { margin: 0; font-size: 21px; }
.topbar-actions { display: flex; align-items: center; gap: 12px; }
.session-label { color: var(--muted); font-size: 13px; }
.inbox-layout {
  min-height: calc(100vh - 74px);
  display: grid;
  grid-template-columns: 240px 360px minmax(0, 1fr);
}
.identity-panel, .message-panel, .detail-panel { min-width: 0; }
.identity-panel, .message-panel { border-right: 1px solid var(--line); }
.identity-panel { padding: 20px 14px; background: #0f1117; }
.message-panel { background: var(--panel); }
.detail-panel { background: #0e1016; }
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 7px 14px;
}
.panel-heading h2 { margin: 0; font-size: 16px; }
.count {
  min-width: 25px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
  text-align: center;
  font-size: 12px;
}
.search-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.search-input { min-height: 38px; margin-bottom: 13px; }
.identity-list, .message-list { list-style: none; margin: 0; padding: 0; }
.identity-button {
  width: 100%;
  border-color: transparent;
  background: transparent;
  padding: 10px;
  text-align: left;
}
.identity-button strong, .identity-button span { display: block; overflow: hidden; text-overflow: ellipsis; }
.identity-button span { color: var(--muted); font-size: 12px; }
.identity-button[aria-current="true"] {
  border-color: #624b16;
  background: var(--amber-soft);
}
.message-heading { min-height: 88px; padding: 18px; border-bottom: 1px solid var(--line); }
.active-address { margin: 0 0 3px; color: var(--amber); font-size: 12px; overflow-wrap: anywhere; }
.message-item { border-bottom: 1px solid var(--line); }
.message-button {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 16px 18px;
  text-align: left;
}
.message-button:hover, .message-button[aria-current="true"] { background: var(--panel-2); }
.message-line { display: flex; justify-content: space-between; gap: 10px; }
.message-from, .message-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-from { font-weight: 750; }
.message-date { flex: none; color: #858997; font-size: 11px; }
.message-subject { margin-top: 4px; }
.message-snippet { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.otp-badge {
  display: inline-block;
  margin-top: 8px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--amber-soft);
  color: #fde68a;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .06em;
}
.empty-state { padding: 28px 20px; color: var(--muted); }
.detail-content { max-width: 920px; margin: auto; padding: 32px clamp(20px, 5vw, 54px); }
.detail-placeholder { max-width: 520px; margin: 12vh auto 0; }
.detail-placeholder h2 { margin: 3px 0 8px; font-size: 28px; }
.detail-header h2 { margin: 5px 0 18px; font-size: clamp(24px, 4vw, 34px); line-height: 1.18; overflow-wrap: anywhere; }
.meta { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 5px 14px; margin: 0 0 22px; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 8px; margin: 22px 0 14px; border-bottom: 1px solid var(--line); }
.tab { border: 0; border-radius: 0; background: transparent; color: var(--muted); }
.tab[aria-selected="true"] { border-bottom: 2px solid var(--amber); color: var(--text); }
.plain-body {
  min-height: 180px;
  margin: 0;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #090b10;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mail-frame {
  width: 100%;
  min-height: 440px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: white;
}
.info-section { margin-top: 25px; }
.info-section h3 { margin: 0 0 10px; font-size: 15px; }
.code-list, .link-list { display: grid; gap: 9px; }
.code-row, .link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.code-value { color: var(--amber); font: 800 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; }
.link-copy { margin-left: auto; }
.link-text { min-width: 0; flex: 1; }
.link-host, .link-url { display: block; overflow-wrap: anywhere; }
.link-host { font-weight: 750; }
.link-url { color: var(--muted); font-size: 11px; }
.open-link { color: var(--amber); }
.sender-warning { color: #fcd34d; font-size: 12px; }
.mobile-back, .mobile-identity { display: none; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 900px) {
  .inbox-layout { grid-template-columns: 210px 320px minmax(0, 1fr); }
  .session-label { display: none; }
}

@media (max-width: 719px) {
  .topbar { height: 66px; padding: 0 14px; }
  .inbox-layout { min-height: calc(100vh - 66px); display: block; }
  .identity-panel { display: none; }
  .message-panel, .detail-panel { min-height: calc(100vh - 66px); border: 0; }
  .mobile-identity { display: grid; gap: 5px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .mobile-back { display: inline-block; margin: 14px 16px 0; }
  .inbox-view[data-mobile-view="list"] .detail-panel { display: none; }
  .inbox-view[data-mobile-view="detail"] .message-panel { display: none; }
  .detail-content { padding: 22px 16px 40px; }
  .code-row, .link-row { align-items: flex-start; flex-wrap: wrap; }
  .link-copy { margin-left: 0; }
}
`;

export const UI_JS = `(function () {
  'use strict';

  history.replaceState(null, '', window.location.pathname);

  var state = {
    me: null,
    identities: [],
    identityFilter: '',
    activeAddress: '',
    messages: [],
    activeMessageId: '',
    detail: null
  };
  var refreshTask = null;
  var refreshController = null;
  var detailController = null;

  function byId(id) {
    return document.getElementById(id);
  }

  var loginView = byId('login-view');
  var inboxView = byId('inbox-view');
  var loginForm = byId('login-form');
  var loginToken = byId('login-token');
  var loginSubmit = byId('login-submit');
  var loginError = byId('login-error');
  var insecureWarning = byId('insecure-warning');
  var identityList = byId('identity-list');
  var identitySearch = byId('identity-search');
  var identityCount = byId('identity-count');
  var mobileIdentity = byId('mobile-identity-select');
  var activeAddress = byId('active-address');
  var messageList = byId('message-list');
  var messageState = byId('message-state');
  var refreshButton = byId('refresh-button');
  var detailContent = byId('detail-content');
  var mainContent = byId('main-content');
  var statusRegion = byId('status');

  function announce(message) {
    statusRegion.textContent = '';
    window.setTimeout(function () {
      statusRegion.textContent = message;
    }, 0);
  }

  function isLoginContextSafe() {
    var local = ['localhost', '127.0.0.1', '[::1]', '::1'].indexOf(window.location.hostname) !== -1;
    return window.isSecureContext || local;
  }

  function configureLoginGate() {
    var safe = isLoginContextSafe();
    loginToken.disabled = !safe;
    loginSubmit.disabled = !safe;
    insecureWarning.hidden = safe;
    return safe;
  }

  function showLogin(message) {
    inboxView.hidden = true;
    loginView.hidden = false;
    loginError.textContent = message || '';
    configureLoginGate();
    if (!loginToken.disabled) loginToken.focus();
  }

  function showInbox() {
    loginView.hidden = true;
    inboxView.hidden = false;
    loginError.textContent = '';
  }

  async function apiJson(path, options) {
    var init = options || {};
    init.credentials = 'same-origin';
    var response = await fetch(path, init);
    if (response.status === 401) {
      showLogin('Your session expired. Sign in again.');
      throw new Error('session_expired');
    }
    if (!response.ok) {
      var failure = new Error('request_failed');
      failure.status = response.status;
      throw failure;
    }
    return response.json();
  }

  function formatDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  function clearDetail() {
    state.activeMessageId = '';
    state.detail = null;
    detailContent.replaceChildren();
    var placeholder = document.createElement('div');
    placeholder.className = 'detail-placeholder';
    var label = document.createElement('p');
    label.className = 'eyebrow';
    label.textContent = 'Message preview';
    var title = document.createElement('h2');
    title.textContent = 'Select a message';
    var copy = document.createElement('p');
    copy.className = 'muted';
    copy.textContent = 'Choose a message to read its plain text, codes, links, or isolated HTML preview.';
    placeholder.append(label, title, copy);
    detailContent.append(placeholder);
  }

  function filteredIdentities() {
    var needle = state.identityFilter.toLowerCase();
    if (!needle) return state.identities;
    return state.identities.filter(function (identity) {
      return identity.address.toLowerCase().includes(needle) ||
        (identity.name || '').toLowerCase().includes(needle);
    });
  }

  function renderIdentities() {
    identityList.replaceChildren();
    mobileIdentity.replaceChildren();
    identityCount.textContent = String(state.identities.length);

    state.identities.forEach(function (identity) {
      var option = document.createElement('option');
      option.value = identity.address;
      option.textContent = identity.name ? identity.name + ' — ' + identity.address : identity.address;
      option.selected = identity.address === state.activeAddress;
      mobileIdentity.append(option);
    });

    filteredIdentities().forEach(function (identity) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'identity-button';
      button.setAttribute('aria-current', identity.address === state.activeAddress ? 'true' : 'false');
      var name = document.createElement('strong');
      name.textContent = identity.name || identity.address.split('@')[0];
      var address = document.createElement('span');
      address.textContent = identity.address;
      button.append(name, address);
      button.addEventListener('click', function () {
        selectIdentity(identity.address);
      });
      item.append(button);
      identityList.append(item);
    });
  }

  function renderMessages() {
    messageList.replaceChildren();
    activeAddress.textContent = state.activeAddress;
    if (!state.activeAddress) {
      messageState.textContent = 'No inbox identities are available for this session.';
      return;
    }
    if (state.messages.length === 0) {
      messageState.textContent = 'No messages yet. Refresh after a new email arrives.';
      return;
    }
    messageState.textContent = '';

    state.messages.forEach(function (message) {
      var item = document.createElement('li');
      item.className = 'message-item';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-button';
      button.setAttribute('aria-current', message.id === state.activeMessageId ? 'true' : 'false');

      var line = document.createElement('div');
      line.className = 'message-line';
      var from = document.createElement('span');
      from.className = 'message-from';
      from.textContent = message.from || 'Unknown sender';
      var date = document.createElement('time');
      date.className = 'message-date';
      date.dateTime = message.date || '';
      date.textContent = formatDate(message.date);
      line.append(from, date);

      var subject = document.createElement('div');
      subject.className = 'message-subject';
      subject.textContent = message.subject || '(no subject)';
      var snippet = document.createElement('p');
      snippet.className = 'message-snippet';
      snippet.textContent = message.snippet || 'No preview';
      button.append(line, subject, snippet);
      if (message.hasOtp) {
        var badge = document.createElement('span');
        badge.className = 'otp-badge';
        badge.textContent = 'CODE / ACTION';
        button.append(badge);
      }
      button.addEventListener('click', function () {
        selectMessage(message.id);
      });
      item.append(button);
      messageList.append(item);
    });
  }

  async function waitForPreviousRefresh() {
    if (!refreshTask) return;
    try {
      await refreshTask;
    } catch {
      return;
    }
  }

  async function selectIdentity(address) {
    if (address === state.activeAddress && state.messages.length) return;
    if (detailController) {
      detailController.abort();
      detailController = null;
    }
    if (refreshController) refreshController.abort();
    await waitForPreviousRefresh();
    state.activeAddress = address;
    state.messages = [];
    clearDetail();
    renderIdentities();
    renderMessages();
    inboxView.dataset.mobileView = 'list';
    await refreshMessages();
  }

  async function refreshMessages() {
    if (!state.activeAddress || refreshTask) return;
    var requestedAddress = state.activeAddress;
    var controller = new AbortController();
    refreshController = controller;
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    messageState.textContent = 'Loading messages…';

    var task = (async function () {
      var payload = await apiJson(
        '/ui/api/messages?address=' + encodeURIComponent(requestedAddress) + '&limit=50',
        { signal: controller.signal }
      );
      if (state.activeAddress !== requestedAddress) return;
      state.messages = Array.isArray(payload.messages) ? payload.messages : [];
      renderMessages();
      renderIdentities();
      announce(state.messages.length + ' messages loaded');
    })();
    refreshTask = task;
    try {
      await task;
    } catch (error) {
      if (error.name !== 'AbortError' && error.message !== 'session_expired') {
        messageState.textContent = 'Messages could not be loaded. Try Refresh.';
      }
    } finally {
      if (refreshTask === task) refreshTask = null;
      if (refreshController === controller) refreshController = null;
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh';
    }
  }

  function appendMeta(list, labelText, valueText) {
    var term = document.createElement('dt');
    term.textContent = labelText;
    var value = document.createElement('dd');
    value.textContent = valueText || '—';
    list.append(term, value);
  }

  function selectForManualCopy(sourceNode) {
    var range = document.createRange();
    range.selectNodeContents(sourceNode);
    var selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString() === sourceNode.textContent;
  }

  async function copyValue(value, sourceNode) {
    try {
      await navigator.clipboard.writeText(value);
      announce('Copied to clipboard');
    } catch {
      var selected = selectForManualCopy(sourceNode);
      announce(selected
        ? 'Clipboard unavailable. The value is selected for manual copying.'
        : 'Clipboard unavailable. Select the value and copy it manually.');
    }
  }

  function parsedHttpUrl(candidate) {
    try {
      var parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function linkRow(candidate) {
    var parsed = parsedHttpUrl(candidate);
    if (!parsed) return null;
    var row = document.createElement('div');
    row.className = 'link-row';
    var text = document.createElement('div');
    text.className = 'link-text';
    var host = document.createElement('span');
    host.className = 'link-host';
    host.textContent = parsed.hostname;
    var url = document.createElement('span');
    url.className = 'link-url';
    url.textContent = parsed.href;
    text.append(host, url);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'quiet link-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      copyValue(parsed.href, url);
    });

    var open = document.createElement('a');
    open.className = 'open-link';
    open.textContent = 'Open';
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.referrerPolicy = 'no-referrer';
    open.href = parsed.href;
    row.append(text, copy, open);
    return row;
  }

  function appendLinks(parent, titleText, links) {
    var validRows = [];
    (Array.isArray(links) ? links : []).forEach(function (candidate) {
      var row = linkRow(candidate);
      if (row) validRows.push(row);
    });
    if (!validRows.length) return;
    var section = document.createElement('section');
    section.className = 'info-section';
    var title = document.createElement('h3');
    title.textContent = titleText;
    var warning = document.createElement('p');
    warning.className = 'sender-warning';
    warning.textContent = 'This link came from the sender. Check the domain before opening it.';
    var list = document.createElement('div');
    list.className = 'link-list';
    list.append.apply(list, validRows);
    section.append(title, warning, list);
    parent.append(section);
  }

  function appendOtp(parent, otp) {
    if (!otp) return;
    var codes = Array.isArray(otp.codes) ? otp.codes : [];
    if (codes.length) {
      var section = document.createElement('section');
      section.className = 'info-section';
      var title = document.createElement('h3');
      title.textContent = 'Verification codes';
      var list = document.createElement('div');
      list.className = 'code-list';
      codes.forEach(function (code) {
        var row = document.createElement('div');
        row.className = 'code-row';
        var value = document.createElement('code');
        value.className = 'code-value';
        value.textContent = code;
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'quiet';
        copy.textContent = 'Copy';
        copy.addEventListener('click', function () {
          copyValue(code, value);
        });
        row.append(value, copy);
        list.append(row);
      });
      section.append(title, list);
      parent.append(section);
    }
    appendLinks(parent, 'Verification links', otp.links);
  }

  function renderPlainBody(container, detail) {
    container.replaceChildren();
    var plain = document.createElement('pre');
    plain.className = 'plain-body';
    plain.textContent = detail.text || 'This message has no plain-text body.';
    container.append(plain);
  }

  function renderHtmlBody(container, detail) {
    container.replaceChildren();
    var frame = document.createElement('iframe');
    frame.className = 'mail-frame';
    frame.title = 'Isolated HTML email preview';
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', '');
    frame.src = '/ui/frame/' + encodeURIComponent(detail.id) +
      '?address=' + encodeURIComponent(state.activeAddress);
    container.append(frame);
  }

  function renderDetail(detail) {
    detailContent.replaceChildren();
    var header = document.createElement('header');
    header.className = 'detail-header';
    var label = document.createElement('p');
    label.className = 'eyebrow';
    label.textContent = 'Message';
    var title = document.createElement('h2');
    title.textContent = detail.subject || '(no subject)';
    var meta = document.createElement('dl');
    meta.className = 'meta';
    appendMeta(meta, 'From', detail.from);
    appendMeta(meta, 'To', detail.to);
    appendMeta(meta, 'Date', formatDate(detail.date));
    header.append(label, title, meta);

    var tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.setAttribute('role', 'tablist');
    var plainTab = document.createElement('button');
    plainTab.type = 'button';
    plainTab.className = 'tab';
    plainTab.textContent = 'Plain text';
    plainTab.setAttribute('role', 'tab');
    plainTab.setAttribute('aria-selected', 'true');
    var htmlTab = document.createElement('button');
    htmlTab.type = 'button';
    htmlTab.className = 'tab';
    htmlTab.textContent = 'HTML preview';
    htmlTab.setAttribute('role', 'tab');
    htmlTab.setAttribute('aria-selected', 'false');
    htmlTab.disabled = !detail.hasHtml || detail.htmlTooLarge;
    if (detail.htmlTooLarge) {
      htmlTab.title = 'This email is too large to preview safely.';
    }
    tabs.append(plainTab, htmlTab);

    var body = document.createElement('section');
    body.setAttribute('role', 'tabpanel');
    renderPlainBody(body, detail);
    plainTab.addEventListener('click', function () {
      plainTab.setAttribute('aria-selected', 'true');
      htmlTab.setAttribute('aria-selected', 'false');
      renderPlainBody(body, detail);
    });
    htmlTab.addEventListener('click', function () {
      plainTab.setAttribute('aria-selected', 'false');
      htmlTab.setAttribute('aria-selected', 'true');
      renderHtmlBody(body, detail);
    });

    detailContent.append(header, tabs);
    if (detail.htmlTooLarge) {
      var htmlUnavailable = document.createElement('p');
      htmlUnavailable.className = 'notice warning';
      htmlUnavailable.textContent =
        'This email is too large to preview safely. Use the plain-text view instead.';
      detailContent.append(htmlUnavailable);
    }
    detailContent.append(body);
    appendOtp(detailContent, detail.otp);
    appendLinks(detailContent, 'Links in this message', detail.links);
  }

  async function selectMessage(id) {
    if (detailController) detailController.abort();
    var controller = new AbortController();
    var requestedDetailAddress = state.activeAddress;
    detailController = controller;
    state.activeMessageId = id;
    renderMessages();
    detailContent.replaceChildren();
    var loading = document.createElement('p');
    loading.className = 'empty-state';
    loading.textContent = 'Loading message…';
    detailContent.append(loading);
    inboxView.dataset.mobileView = 'detail';
    try {
      var detail = await apiJson(
        '/ui/api/messages/' + encodeURIComponent(id) +
          '?address=' + encodeURIComponent(requestedDetailAddress),
        { signal: controller.signal }
      );
      if (
        detailController !== controller ||
        state.activeAddress !== requestedDetailAddress
      ) return;
      state.detail = detail;
      renderDetail(detail);
      mainContent.focus();
    } catch (error) {
      if (error.name !== 'AbortError' && error.message !== 'session_expired') {
        loading.textContent = 'This message could not be loaded.';
      }
    } finally {
      if (detailController === controller) detailController = null;
    }
  }

  async function loadInbox() {
    var identityPayload = await apiJson('/ui/api/identities');
    state.identities = Array.isArray(identityPayload.identities) ? identityPayload.identities : [];
    state.activeAddress = state.identities[0] ? state.identities[0].address : '';
    renderIdentities();
    renderMessages();
    clearDetail();
    if (state.activeAddress) await refreshMessages();
  }

  loginForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!configureLoginGate()) return;
    loginError.textContent = '';
    loginSubmit.disabled = true;
    var credential = loginToken.value;
    loginToken.value = '';
    try {
      var response = await fetch('/ui/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: credential })
      });
      if (!response.ok) {
        loginError.textContent = response.status === 401
          ? 'That token is not valid.'
          : 'Sign-in is temporarily unavailable. Try again.';
        return;
      }
      state.me = await response.json();
      showInbox();
      byId('session-label').textContent = state.me.kind === 'admin'
        ? 'Admin session'
        : state.me.address;
      await loadInbox();
    } catch {
      loginError.textContent = 'Could not reach the server.';
    } finally {
      loginSubmit.disabled = !isLoginContextSafe();
    }
  });

  byId('logout-button').addEventListener('click', async function () {
    try {
      await fetch('/ui/api/session', {
        method: 'DELETE',
        credentials: 'same-origin'
      });
    } finally {
      state.me = null;
      state.identities = [];
      state.messages = [];
      showLogin('');
    }
  });

  identitySearch.addEventListener('input', function () {
    state.identityFilter = identitySearch.value;
    renderIdentities();
  });
  mobileIdentity.addEventListener('change', function () {
    selectIdentity(mobileIdentity.value);
  });
  refreshButton.addEventListener('click', function () {
    refreshMessages();
  });
  byId('mobile-back').addEventListener('click', function () {
    inboxView.dataset.mobileView = 'list';
    var active = messageList.querySelector('[aria-current="true"]');
    if (active) active.focus();
  });

  (async function start() {
    configureLoginGate();
    try {
      var response = await fetch('/ui/api/me', { credentials: 'same-origin' });
      if (response.status === 401) { showLogin(''); return; }
      if (!response.ok) throw new Error('request_failed');
      state.me = await response.json();
      showInbox();
      byId('session-label').textContent = state.me.kind === 'admin'
        ? 'Admin session'
        : state.me.address;
      await loadInbox();
    } catch {
      showLogin('Could not reach the server.');
    }
  })();
})();`;
