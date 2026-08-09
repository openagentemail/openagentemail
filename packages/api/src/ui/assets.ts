// font-src 'self'：Satoshi 由 /ui/fonts/ 同源提供（见 routes/ui-assets.ts），不放行任何外源。
export const OUTER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// ⚠ 模块私有：这一行前面**不得**加 export —— 整个模块只允许导出一个 logo 常量
// （`UI_LOGO_SVG`）。几何与 website/public/logo.svg 逐字一致。
const logoGeometry = `  <rect width="32" height="32" rx="7" fill="#0c0d12"/>
  <rect x="5" y="5" width="22" height="22" rx="6" fill="none" stroke="#fbbf24" stroke-width="2.2"/>
  <path d="M11.1 10q.55 1.65 2.2 2.2-1.65.55-2.2 2.2-.55-1.65-2.2-2.2 1.65-.55 2.2-2.2z" fill="#fbbf24"/>
  <path d="M20.9 10q.55 1.65 2.2 2.2-1.65.55-2.2 2.2-.55-1.65-2.2-2.2 1.65-.55 2.2-2.2z" fill="#fbbf24"/>
  <path d="M5.8 15.8 16 23 26.2 15.8" fill="none" stroke="#fbbf24" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`;

/** 唯一导出的 logo 常量：favicon 路由与"与官网文件逐字比对"的测试都只认它。 */
export const UI_LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n${logoGeometry}\n</svg>\n`;

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>OpenAgent Inbox</title>
  <link rel="icon" href="/ui/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/ui/styles.css">
  <script src="/ui/app.js" defer></script>
</head>
<body>
  <a id="skip-link" class="skip-link" href="#main-content">Skip to inbox</a>

  <svg class="svg-defs" aria-hidden="true" focusable="false" width="0" height="0">
    <symbol id="oa-mark" viewBox="0 0 32 32">${logoGeometry}</symbol>
  </svg>

  <main id="login-view" class="login-view">
    <section class="login-card" aria-labelledby="login-title">
      <div class="brand-row"><svg class="brand-logo" aria-hidden="true" focusable="false" width="40" height="40"><use href="#oa-mark"/></svg><span class="wordmark">OpenAgent.email</span></div>
      <h1 id="login-title">Your inbox, without the noise.</h1>
      <p class="muted">Paste an admin or identity API token. It is exchanged for a private, browser-only session cookie.</p>
      <form id="login-form">
        <label for="login-token">API token</label>
        <input id="login-token" name="credential" type="password" autocomplete="current-password" maxlength="512" required>
        <label class="remember-row" for="login-remember">
          <input id="login-remember" type="checkbox">
          <span>Trust this device for 30 days</span>
        </label>
        <button id="login-submit" class="primary" type="submit">Open inbox</button>
      </form>
      <p id="insecure-warning" class="notice warning" hidden>This connection is not secure. Open the inbox over HTTPS or an SSH tunnel before entering a token.</p>
      <p id="login-error" class="notice error" aria-live="polite"></p>
      <p class="fine-print">The token never enters the address bar and is not stored by the page.</p>
    </section>
  </main>

  <section id="inbox-view" class="inbox-view" data-session="identity" data-scope="inbox" data-mobile-view="list" hidden>
    <header class="topbar">
      <div class="topbar-brand">
        <svg class="brand-logo" aria-hidden="true" focusable="false" width="24" height="24"><use href="#oa-mark"/></svg>
        <span class="wordmark">OpenAgent.email</span>
        <h1 id="view-title">Inbox</h1>
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

      <div class="mobile-identity">
        <label for="mobile-identity-select">Address</label>
        <select id="mobile-identity-select"></select>
      </div>

      <main id="overview-panel" class="overview-panel" tabindex="-1" aria-labelledby="overview-title" hidden>
        <div class="panel-heading overview-heading">
          <div>
            <h2 id="overview-title">Overview</h2>
            <p id="overview-subtitle" class="overview-subtitle">All addresses · counts from the newest 500 messages</p>
            <p id="overview-overlap" class="overview-subtitle">Counts overlap when one email is addressed to several addresses.</p>
            <p id="overview-updated" class="overview-updated"></p>
          </div>
          <div class="overview-heading-actions">
            <button id="create-identity-button" class="primary" type="button" hidden>Create Identity</button>
            <button id="overview-refresh" class="quiet" type="button">Refresh</button>
          </div>
        </div>
        <p id="overview-notice" class="notice warning" hidden></p>
        <div id="overview-stats" class="overview-stats"></div>
        <p id="overview-disclosure" class="overview-disclosure" hidden></p>
        <div class="overview-controls">
          <label class="search-label" for="overview-search">Filter addresses</label>
          <input id="overview-search" class="search-input" type="search" placeholder="Filter addresses" autocomplete="off">
          <span id="overview-shown" class="count"></span>
        </div>
        <div id="overview-sort" class="overview-sort" role="group" aria-label="Sort addresses"></div>
        <p id="overview-state" class="empty-state"></p>
        <div class="overview-header" aria-hidden="true">
          <span>Identity</span>
          <span>Token</span>
          <span>Messages</span>
          <span>Unseen</span>
          <span>Last</span>
          <span>Created</span>
          <span>Push</span>
          <span>Actions</span>
        </div>
        <div id="overview-rows" class="overview-rows"></div>
      </main>

      <main id="notify-panel" class="notify-panel" tabindex="-1" aria-labelledby="notify-title" hidden>
        <div class="panel-heading overview-heading">
          <div>
            <h2 id="notify-title">Notifications</h2>
            <p id="notify-subtitle" class="overview-subtitle">Push history from ntfy cache (last 12 hours)</p>
            <p id="notify-updated" class="overview-updated"></p>
          </div>
          <div class="overview-heading-actions">
            <button id="notify-refresh" class="quiet" type="button">Refresh</button>
          </div>
        </div>
        <p id="notify-notice" class="notice warning" hidden></p>
        <div class="overview-controls notify-controls">
          <label class="search-label" for="notify-topic-filter">Filter channel</label>
          <select id="notify-topic-filter" class="search-input notify-topic-filter" hidden>
            <option value="">All channels</option>
          </select>
          <span id="notify-shown" class="count"></span>
        </div>
        <p id="notify-state" class="empty-state"></p>
        <div class="notify-header" aria-hidden="true">
          <span>When</span>
          <span>Channel</span>
          <span>Tier</span>
          <span>Content</span>
        </div>
        <div id="notify-rows" class="notify-rows"></div>
      </main>

      <main id="tasks-panel" class="tasks-panel" tabindex="-1" aria-labelledby="tasks-title" hidden>
        <div class="panel-heading overview-heading">
          <div>
            <h2 id="tasks-title">Tasks</h2>
            <p id="tasks-subtitle" class="overview-subtitle">Task tickets rebuilt from X-OA-Task mail threads</p>
            <p id="tasks-updated" class="overview-updated"></p>
          </div>
          <div class="overview-heading-actions">
            <button id="tasks-refresh" class="quiet" type="button">Refresh</button>
          </div>
        </div>
        <p id="tasks-notice" class="notice warning" hidden></p>
        <div class="tasks-layout">
          <div id="tasks-list-section" class="tasks-list-section" aria-label="Task list">
            <div class="overview-controls notify-controls">
              <label class="search-label" for="tasks-state-filter">Filter state</label>
              <select id="tasks-state-filter" class="search-input notify-topic-filter">
                <option value="">All states</option>
                <option value="submitted">submitted</option>
                <option value="working">working</option>
                <option value="input-required">input-required</option>
                <option value="completed">completed</option>
                <option value="failed">failed</option>
              </select>
              <span id="tasks-shown" class="count"></span>
            </div>
            <p id="tasks-state" class="empty-state"></p>
            <div class="tasks-header" aria-hidden="true">
              <span>State</span>
              <span>Participants</span>
              <span>Subject</span>
              <span>Updated</span>
              <span>Msgs</span>
            </div>
            <div id="tasks-rows" class="tasks-rows"></div>
          </div>
          <div id="tasks-detail-section" class="tasks-detail-section" tabindex="-1" aria-label="Task detail">
            <button id="tasks-mobile-back" class="quiet mobile-back" type="button">Back to tasks</button>
            <div id="tasks-detail-content" class="tasks-detail-content">
              <div class="detail-placeholder">
                <p class="eyebrow">Task ticket</p>
                <h2>Select a task</h2>
                <p class="muted">Choose a ticket to inspect its state timeline and result.</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <main id="main-content" class="inbox-main" tabindex="-1">
        <section id="message-panel" class="message-panel" aria-labelledby="messages-title">
          <div class="panel-heading message-heading">
            <div>
              <button id="back-to-overview" class="quiet back-link" type="button">← Overview</button>
              <p id="active-address" class="active-address"></p>
              <h2 id="messages-title" tabindex="-1">Messages</h2>
            </div>
            <button id="refresh-button" class="quiet" type="button">Refresh</button>
          </div>
          <div id="message-state" class="empty-state"></div>
          <ol id="message-list" class="message-list"></ol>
        </section>

        <section id="detail-panel" class="detail-panel" tabindex="-1">
          <button id="mobile-back" class="quiet mobile-back" type="button">Back to messages</button>
          <div id="detail-content" class="detail-content">
            <div class="detail-placeholder">
              <p class="eyebrow">Message preview</p>
              <h2>Select a message</h2>
              <p class="muted">Choose a message to read its plain text, codes, links, or isolated HTML preview.</p>
            </div>
          </div>
        </section>
      </main>
    </div>

    <div class="modal-overlay" id="token-modal" hidden>
      <div class="modal-card">
        <h2 id="token-modal-title">Token</h2>
        <p class="modal-warn">Copy this token now. It will not be shown again.</p>
        <div class="token-display">
          <code id="token-value"></code>
          <button class="quiet" id="token-copy-button" type="button">Copy</button>
        </div>
        <div class="modal-actions">
          <button class="primary" id="token-modal-close" type="button">Done</button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="confirm-modal" hidden>
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-text confirm-modal-risk"
      >
        <h2 id="confirm-modal-title">Confirm</h2>
        <p id="confirm-modal-text"></p>
        <p id="confirm-modal-risk" class="modal-warn" hidden></p>
        <div class="modal-actions">
          <button class="quiet" id="confirm-modal-cancel" type="button">Cancel</button>
          <button class="primary" id="confirm-modal-confirm" type="button">Confirm</button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="create-modal" hidden>
      <div class="modal-card">
        <h2>Create Identity</h2>
        <label>Display name (optional)
          <input type="text" id="create-name" maxlength="100" placeholder="My Bot">
        </label>
        <label>Custom address (optional)
          <div class="localpart-input">
            <input type="text" id="create-localpart" pattern="[a-z0-9][a-z0-9._-]*" maxlength="63" placeholder="my-bot">
            <span class="localpart-suffix">@<span id="create-domain"></span></span>
          </div>
        </label>
        <p class="form-hint">Leave address blank for a random one.</p>
        <div class="modal-actions">
          <button class="quiet" id="create-modal-cancel" type="button">Cancel</button>
          <button class="primary" id="create-modal-submit" type="button">Create</button>
        </div>
      </div>
    </div>
  </section>

  <div id="status" class="sr-only" aria-live="polite"></div>
</body>
</html>`;

export const UI_CSS = `/* Satoshi 与官网同源同文件（website/public/fonts/，sha256 由测试钉死）。 */
@font-face {
  font-family: 'Satoshi';
  src: url('/ui/fonts/Satoshi-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Satoshi';
  src: url('/ui/fonts/Satoshi-Medium.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Satoshi';
  src: url('/ui/fonts/Satoshi-Bold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Satoshi';
  src: url('/ui/fonts/Satoshi-Black.woff2') format('woff2');
  font-weight: 900;
  font-style: normal;
  font-display: swap;
}

:root {
  color-scheme: dark;
  --bg: #0c0d12;
  --bg-raise: #12141c;
  --bg-card: #14161f;
  --ink: #f3f4f6;
  --ink-dim: #9ca3af;
  --ink-faint: #6b7280;
  --gold: #fbbf24;
  --gold-soft: #fde68a;
  --gold-dim: rgba(251, 191, 36, 0.14);
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.16);
  --line-control: rgba(255, 255, 255, 0.34);
  --green: #34d399;
  --red: #f87171;
  --sans: 'Satoshi', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --radius: 14px;
}

* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.5 var(--sans);
}
button, input, select { font: inherit; }
button, select { cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
  outline: 3px solid var(--gold);
  outline-offset: 2px;
}
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
.svg-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.skip-link {
  position: fixed;
  left: 12px;
  top: -60px;
  z-index: 20;
  background: var(--gold);
  color: #18120a;
  padding: 9px 14px;
  border-radius: 8px;
}
.skip-link:focus { top: 12px; }
.eyebrow {
  margin: 0 0 5px;
  color: var(--gold);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.muted { color: var(--ink-dim); }
.brand-row { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
.brand-row .wordmark { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.brand-logo { display: block; flex: none; }
.login-view {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(42rem 24rem at 70% 8%, rgba(251, 191, 36, 0.10), transparent 70%),
    radial-gradient(30rem 20rem at 15% 30%, rgba(251, 191, 36, 0.05), transparent 70%),
    radial-gradient(26rem 18rem at 50% 42%, var(--gold-dim), transparent 70%),
    var(--bg);
}
.login-card {
  width: min(100%, 460px);
  padding: 38px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: var(--bg-card);
  box-shadow: 0 30px 80px rgba(0, 0, 0, .5);
}
.login-card h1 { margin: 0; font-size: clamp(28px, 6vw, 40px); line-height: 1.08; letter-spacing: -0.02em; }
.login-card form { display: grid; gap: 9px; margin-top: 28px; }
.remember-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 3px;
  font-weight: 400;
  cursor: pointer;
}
.remember-row input[type="checkbox"] {
  width: 16px;
  min-height: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--gold);
  cursor: pointer;
}
label { color: #d6d7dc; font-size: 13px; font-weight: 700; }
input, select {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--line-control);
  border-radius: 10px;
  background: #0d0f15;
  color: var(--ink);
  padding: 10px 12px;
}
button {
  min-height: 40px;
  border: 1px solid var(--line-control);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--ink);
  padding: 8px 13px;
}
button:hover { border-color: var(--gold-soft); }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary {
  margin-top: 7px;
  min-height: 44px;
  border-color: var(--gold);
  background: var(--gold);
  color: #111;
  font-weight: 700;
  border-radius: 10px;
  transition: transform .15s ease, background .15s ease, border-color .15s ease;
}
.primary:hover { background: var(--gold-soft); border-color: var(--gold-soft); transform: translateY(-1px); }
.primary:disabled:hover { transform: none; background: var(--gold); border-color: var(--gold); }
.quiet { background: transparent; }
.seen-toggle { margin-top: 14px; font-size: 13px; }
.notice { min-height: 1.5em; margin: 13px 0 0; }
.notice.error { color: var(--red); }
.notice.warning {
  padding: 10px 12px;
  border: 1px solid rgba(251, 191, 36, 0.4);
  border-radius: 10px;
  background: var(--gold-dim);
  color: var(--gold-soft);
}
.fine-print { margin: 20px 0 0; color: var(--ink-dim); font-size: 12px; }
.inbox-view { min-height: 100vh; }
.topbar {
  height: 74px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 22px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--bg);
}
.topbar-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.topbar-brand .wordmark { font-size: 14px; font-weight: 700; color: var(--ink); }
.topbar h1 { margin: 0 0 0 8px; padding-left: 12px; border-left: 1px solid var(--line-strong); font-size: 21px; }
.topbar-actions { display: flex; align-items: center; gap: 12px; }
.session-label { color: var(--ink-dim); font-size: 13px; }
.inbox-layout {
  min-height: calc(100vh - 74px);
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
}
.inbox-main {
  min-width: 0;
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
}
.identity-panel, .message-panel, .detail-panel, .overview-panel, .notify-panel, .tasks-panel { min-width: 0; }
.identity-panel, .message-panel { border-right: 1px solid var(--line-strong); }
.identity-panel { padding: 20px 14px; background: var(--bg); }
.inbox-view[data-scope="overview"] .identity-panel,
.inbox-view[data-scope="notifications"] .identity-panel,
.inbox-view[data-scope="tasks"] .identity-panel { border-right-color: var(--line-strong); }
.message-panel { background: var(--bg-raise); }
.detail-panel { background: var(--bg); }
.overview-panel, .notify-panel, .tasks-panel { background: var(--bg); padding: 20px clamp(16px, 3vw, 30px) 48px; overflow-x: hidden; }
.notify-topic-filter { max-width: 280px; }
.tasks-layout {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(280px, 1.1fr) minmax(0, 1.4fr);
  gap: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-raise);
}
.tasks-list-section { min-width: 0; border-right: 1px solid var(--line-strong); background: var(--bg-raise); padding: 14px 12px 24px; }
.tasks-detail-section { min-width: 0; background: var(--bg); padding: 0; }
.tasks-detail-content { padding: 22px 20px 40px; }
.tasks-header {
  display: grid;
  gap: 10px;
  grid-template-columns: 110px minmax(120px, 1.2fr) minmax(0, 1.6fr) 96px 48px;
  padding: 8px 10px;
  color: var(--ink-dim);
  font-size: 11px;
  letter-spacing: .06em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--line);
}
.tasks-rows { border-top: 1px solid var(--line); }
.task-row {
  width: 100%;
  display: grid;
  gap: 10px;
  grid-template-columns: 110px minmax(120px, 1.2fr) minmax(0, 1.6fr) 96px 48px;
  align-items: start;
  padding: 12px 10px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
  min-height: 44px;
}
.task-row:hover, .task-row[aria-current="true"] { background: var(--gold-dim); }
.task-row .cell-label { display: none; color: var(--ink-dim); font-size: 12px; }
.task-participants { min-width: 0; font-size: 12px; color: var(--ink-dim); }
.task-participants > span:last-child {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-subject { margin: 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-updated { color: var(--ink-dim); font-size: 13px; font-variant-numeric: tabular-nums; }
.task-msgs { color: var(--ink-dim); font-size: 13px; font-variant-numeric: tabular-nums; }
.task-badge {
  display: inline-block;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--ink-dim);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.task-badge[data-state="submitted"] { border-color: rgba(96, 165, 250, 0.45); color: #93c5fd; }
.task-badge[data-state="working"] { border-color: rgba(251, 191, 36, 0.45); color: var(--gold); }
.task-badge[data-state="input-required"] { border-color: rgba(251, 146, 60, 0.5); color: #fdba74; }
.task-badge[data-state="completed"] { border-color: rgba(52, 211, 153, 0.45); color: var(--green); }
.task-badge[data-state="failed"] { border-color: rgba(248, 113, 113, 0.45); color: var(--red); }
.task-detail-head { display: grid; gap: 8px; margin-bottom: 18px; }
.task-detail-head h3 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
.task-detail-meta { margin: 0; color: var(--ink-dim); font-size: 13px; }
.task-timeline { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.task-timeline-item {
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.task-timeline-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 8px;
}
.task-timeline-from { font-size: 13px; font-weight: 700; }
.task-timeline-time { color: var(--ink-dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.task-timeline-body {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.task-result {
  margin-top: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-card);
  padding: 10px 12px;
}
.task-result summary {
  cursor: pointer;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.task-result pre {
  margin: 10px 0 0;
  overflow: auto;
  max-height: 320px;
  font: 12px/1.45 var(--mono);
  color: var(--gold-soft);
  white-space: pre-wrap;
  word-break: break-word;
}
.notify-header {
  display: grid;
  gap: 10px;
  grid-template-columns: 160px 140px 88px minmax(0, 1fr);
  padding: 8px 10px;
  color: var(--ink-dim);
  font-size: 11px;
  letter-spacing: .06em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--line);
}
.notify-rows { border-top: 1px solid var(--line); }
.notify-row {
  display: grid;
  gap: 10px;
  grid-template-columns: 160px 140px 88px minmax(0, 1fr);
  align-items: start;
  padding: 12px 10px;
  border-bottom: 1px solid var(--line);
  min-height: 44px;
}
.notify-row:hover { background: var(--gold-dim); }
.notify-row .cell-label { display: none; color: var(--ink-dim); font-size: 12px; }
.notify-when { color: var(--ink-dim); font-size: 13px; font-variant-numeric: tabular-nums; }
.notify-channel { font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
.notify-tier {
  display: inline-block;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--ink-dim);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.notify-tier[data-tier="urgent"] { border-color: rgba(248, 113, 113, 0.45); color: var(--red); }
.notify-tier[data-tier="normal"] { border-color: rgba(251, 191, 36, 0.4); color: var(--gold); }
.notify-tier[data-tier="low"], .notify-tier[data-tier="unknown"] { color: var(--ink-dim); }
.notify-title-text { margin: 0; font-size: 14px; font-weight: 700; }
.notify-body-text { margin: 4px 0 0; color: var(--ink-dim); font-size: 13px; white-space: pre-wrap; word-break: break-word; }
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 7px 14px;
}
.panel-heading h2 { margin: 0; font-size: 16px; }
.overview-heading { align-items: flex-start; padding: 4px 0 18px; }
.overview-heading h2 { font-size: 22px; letter-spacing: -0.01em; }
.overview-heading-actions { display: flex; align-items: center; gap: 8px; }
.overview-heading-actions .primary { margin-top: 0; }
.overview-subtitle { margin: 6px 0 0; color: var(--ink-dim); font-size: 14px; }
.overview-updated { margin: 4px 0 0; color: var(--ink-dim); font-size: 14px; }
.count {
  min-width: 25px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--ink-dim);
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
.identity-button span { color: var(--ink-dim); font-size: 12px; }
.identity-button[aria-current="true"] {
  border-color: rgba(251, 191, 36, 0.4);
  background: var(--gold-dim);
}
.overview-nav { margin-bottom: 6px; border-bottom: 1px solid var(--line); border-radius: 10px 10px 0 0; }
.overview-stats {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
}
.stat-card {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-card);
}
.stat-label { display: block; color: var(--ink-dim); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.stat-value { display: block; margin-top: 6px; color: var(--gold); font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.overview-panel.is-stale .stat-value { color: var(--ink-dim); font-style: italic; }
.overview-disclosure { margin: 12px 0 0; color: var(--ink-dim); font-size: 14px; }
.overview-controls { display: flex; align-items: center; gap: 10px; margin-top: 20px; }
.overview-controls .search-input { margin-bottom: 0; }
.overview-sort { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.sort-button { min-height: 34px; padding: 4px 10px; font-size: 13px; }
.sort-button[aria-pressed="true"] { border-color: var(--gold); color: var(--gold); }
.overview-header {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0,1fr) 80px 96px 80px 120px 96px minmax(110px, 130px) 72px;
  padding: 8px 10px;
  color: var(--ink-dim);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.overview-rows { border-top: 1px solid var(--line); }
.overview-row {
  width: 100%;
  display: grid;
  align-items: baseline;
  gap: 10px;
  grid-template-columns: minmax(0,1fr) 80px 96px 80px 120px 96px minmax(110px, 130px) 72px;
  min-height: 56px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  padding: 12px 10px;
  text-align: left;
}
/* Nav hit-target spans identity…created (cols 1–6); tier/actions stay siblings (F66). */
.overview-row-nav {
  grid-column: 1 / span 6;
  display: grid;
  grid-template-columns: subgrid;
  gap: 10px;
  align-items: baseline;
  min-width: 0;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.overview-row:hover, .overview-row[aria-current="true"] { background: var(--gold-dim); }
.overview-row-nav:focus-visible { outline: 3px solid var(--gold); outline-offset: -3px; }
.overview-row .cell { display: block; overflow: hidden; text-overflow: ellipsis; }
.overview-row .cell-label { display: none; color: var(--ink-dim); font-size: 12px; }
.cell-value { font-variant-numeric: tabular-nums; }
.cell-unit { color: var(--ink-dim); font-size: 12px; }
.row-name { display: block; font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
.row-address { display: block; color: var(--ink-dim); font-size: 13px; overflow-wrap: anywhere; }
.row-note { display: block; color: var(--ink-faint); font-size: 14px; }
.row-flat { color: var(--ink-faint); }
.active-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 999px;
  background: var(--green);
}
.token-cell .cell-value { display: inline-flex; align-items: center; }
.token-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 999px;
  background: var(--red);
  opacity: .65;
}
.token-dot.has-token { background: var(--green); opacity: 1; }
.row-actions { display: grid !important; gap: 4px; align-self: center; overflow: visible !important; }
.row-action { min-height: 26px; padding: 2px 6px; font-size: 11px; }
.delete-action { color: var(--red); }
.push-tier-cell { display: grid !important; gap: 4px; align-self: center; overflow: visible !important; }
.push-tier-select {
  min-height: 28px;
  width: 100%;
  max-width: 118px;
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 8px;
}
.push-tier-hint { color: var(--ink-faint); font-size: 11px; line-height: 1.3; }
.overview-panel.is-error .overview-rows, .overview-panel.is-error .overview-stats { opacity: .8; }
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, .72);
}
.modal-card {
  width: min(100%, 440px);
  max-height: calc(100vh - 32px);
  overflow: auto;
  padding: 24px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--bg-card);
  box-shadow: 0 24px 70px rgba(0, 0, 0, .55);
}
.modal-card h2 { margin: 0 0 14px; }
.modal-card label { display: grid; gap: 7px; margin-top: 14px; }
.modal-warn { margin: 0 0 14px; color: var(--gold); }
.token-display {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #090b10;
}
.token-display code { min-width: 0; flex: 1; color: var(--gold-soft); font-family: var(--mono); overflow-wrap: anywhere; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.modal-actions .primary { margin-top: 0; }
.localpart-input { display: flex; align-items: stretch; }
.localpart-input input { min-width: 0; border-radius: 10px 0 0 10px; }
.localpart-suffix {
  display: flex;
  align-items: center;
  padding: 0 11px;
  border: 1px solid var(--line-control);
  border-left: 0;
  border-radius: 0 10px 10px 0;
  background: #0d0f15;
  color: var(--ink-dim);
  white-space: nowrap;
}
.form-hint { margin: 8px 0 0; color: var(--ink-dim); font-size: 12px; }
.back-link { margin: 0 0 8px; padding: 4px 8px; min-height: 32px; font-size: 13px; }
.message-heading { min-height: 88px; padding: 18px; border-bottom: 1px solid var(--line-strong); align-items: flex-end; }
.active-address { margin: 0 0 3px; color: var(--gold); font-size: 12px; overflow-wrap: anywhere; }
.message-item { border-bottom: 1px solid var(--line); }
.message-button {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 16px 18px;
  text-align: left;
}
.message-button:hover, .message-button[aria-current="true"] { background: var(--bg-card); }
.message-line { display: flex; justify-content: space-between; gap: 10px; }
.message-from, .message-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-from { font-weight: 750; }
.message-date { flex: none; color: var(--ink-dim); font-size: 11px; }
.message-subject { margin-top: 4px; }
.message-snippet { margin: 5px 0 0; color: var(--ink-dim); font-size: 12px; }
.otp-badge {
  display: inline-block;
  margin-top: 8px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--gold-dim);
  color: var(--gold-soft);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .06em;
}
.empty-state { padding: 28px 20px; color: var(--ink-dim); }
.empty-state:empty { display: none; }
.detail-content { max-width: 920px; margin: auto; padding: 32px clamp(20px, 5vw, 54px); }
.detail-placeholder { max-width: 520px; margin: 12vh auto 0; }
.detail-placeholder h2 { margin: 3px 0 8px; font-size: 28px; }
.detail-header h2 { margin: 5px 0 18px; font-size: clamp(24px, 4vw, 34px); line-height: 1.18; overflow-wrap: anywhere; }
.meta { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 5px 14px; margin: 0 0 22px; }
.meta dt { color: var(--ink-dim); }
.meta dd { margin: 0; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 8px; margin: 22px 0 14px; border-bottom: 1px solid var(--line-strong); }
.tab { border: 0; border-radius: 0; background: transparent; color: var(--ink-dim); }
.tab[aria-selected="true"] { border-bottom: 2px solid var(--gold); color: var(--ink); }
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
  border: 1px solid var(--line-strong);
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
  background: var(--bg-raise);
}
.code-value { color: var(--gold); font: 800 20px/1 var(--mono); letter-spacing: .1em; }
.copied { border-color: var(--green); color: var(--green); }
.link-copy { margin-left: auto; }
.link-text { min-width: 0; flex: 1; }
.link-host, .link-url { display: block; overflow-wrap: anywhere; }
.link-host { font-weight: 750; }
.link-url { color: var(--ink-dim); font-size: 11px; }
.open-link { color: var(--gold); }
.sender-warning { color: var(--gold-soft); font-size: 12px; }
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

/*
 * Desktop overview fixed tracks+gaps ≈724px + 240 sidebar + panel pad ≈1044px → compact to 1100px.
 * Compact fixed tracks+gaps+row pad ≈542px + 210 sidebar + panel pad ≈800px → stack below 820px
 * so portrait tablets (720–800) do not collapse the identity track.
 */
@media (max-width: 1100px) {
  .inbox-layout { grid-template-columns: 210px minmax(0, 1fr); }
  .inbox-main { grid-template-columns: 320px minmax(0, 1fr); }
  .overview-header, .overview-row {
    gap: 6px;
    grid-template-columns: minmax(0, 1fr) 58px 60px 58px 80px 66px 100px 58px;
  }
  .overview-row-nav { gap: 6px; }
  .session-label { display: none; }
}

@media (max-width: 820px) {
  .topbar { height: 66px; padding: 0 14px; gap: 10px; }
  .topbar h1 { font-size: 18px; }
  /* 375 px 下品牌名让位给 scope 标题与 Sign out，logo 与按钮都不许换行溢出 */
  .topbar-brand .wordmark { display: none; }
  .topbar-actions .quiet { white-space: nowrap; }
  .inbox-layout { min-height: calc(100vh - 66px); display: block; }
  .inbox-main { display: block; }
  .identity-panel { display: none; }
  .message-panel, .detail-panel, .overview-panel, .notify-panel, .tasks-panel { min-height: calc(100vh - 66px); border: 0; }
  .mobile-identity { display: grid; gap: 5px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .mobile-back { display: inline-block; margin: 14px 16px 0; }
  .inbox-view[data-mobile-view="list"] .detail-panel { display: none; }
  .inbox-view[data-mobile-view="detail"] .message-panel { display: none; }
  .notify-header { display: none; }
  .notify-row { display: block; }
  .notify-row .cell { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 24px; margin-bottom: 4px; }
  .notify-row .cell-label { display: inline; }
  .notify-row .notify-content { display: block; }
  .tasks-layout { display: block; border: 0; border-radius: 0; background: transparent; }
  .tasks-list-section { border: 0; padding: 0; background: transparent; }
  .tasks-detail-section { padding: 0; }
  .tasks-detail-content { padding: 22px 16px 40px; }
  .inbox-view[data-mobile-view="tasks-list"] .tasks-detail-section { display: none; }
  .inbox-view[data-mobile-view="tasks-detail"] .tasks-list-section { display: none; }
  .tasks-header { display: none; }
  .task-row { display: block; }
  .task-row .cell { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 24px; margin-bottom: 4px; }
  .task-row .cell-label { display: inline; }
  .task-row .task-subject { white-space: normal; }
  .inbox-view[data-mobile-view="overview"] .overview-stats { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .inbox-view[data-mobile-view="overview"] .stat-card {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    border-radius: 0;
    border-width: 0 0 1px;
  }
  .inbox-view[data-mobile-view="overview"] .stat-value { margin-top: 0; font-size: 20px; }
  .overview-heading { flex-wrap: wrap; }
  .overview-header { display: none; }
  .overview-row { display: block; min-height: 44px; }
  .overview-row-nav {
    display: block;
    grid-column: auto;
    grid-template-columns: none;
  }
  .overview-row .cell { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 24px; }
  .overview-row .cell-label { display: inline; }
  .overview-row .cell-unit { display: none; }
  .row-actions { display: flex !important; justify-content: flex-end !important; }
  .detail-content { padding: 22px 16px 40px; }
  .code-row, .link-row { align-items: flex-start; flex-wrap: wrap; }
  .link-copy { margin-left: 0; }
}
`;

export const UI_JS = `(function () {
  'use strict';

  history.replaceState(null, '', window.location.pathname);

  /* 客户端唯一的新鲜度阈值（与服务端 FRESH_MS 同值）。不存在第二个 TTL。 */
  var FRESH_MS = 15000;
  var POLL_LIMIT = 15;
  var POLL_WINDOW_MS = 20000;
  /* 通知面板 DOM 行数上限：12h 窗口可能数千条，全量建节点会卡死页面。 */
  var NOTIFY_RENDER_LIMIT = 500;
  var SORT_COLUMNS = [
    { key: 'address', label: 'Address' },
    { key: 'name', label: 'Name' },
    { key: 'count', label: 'Messages' },
    { key: 'unseen', label: 'Unseen' },
    { key: 'last', label: 'Last' },
    { key: 'created', label: 'Created' }
  ];

  var state = {
    me: null,
    identities: [],
    identityFilter: '',
    activeAddress: '',
    messages: [],
    activeMessageId: '',
    detail: null,
    scope: 'inbox',
    overviewStatus: 'idle',
    overview: null,
    overviewMessage: '',
    overviewFilter: '',
    overviewSort: { key: 'last', dir: 'desc' },
    overviewGen: 0,
    /* Generation of the in-flight loadOverviewCycle (0 when none owns pending). */
    overviewCycleGen: 0,
    overviewPolls: 0,
    overviewRetryAt: 0,
    overviewPending: false,
    overviewLoadingSince: 0,
    returnAddress: '',
    /* address -> true while a push-tier PUT is in flight (survives re-render). */
    tierPending: {},
    /* 通知记录：合并后的行（含逻辑 topic），以及加载态 */
    notifyMessages: [],
    notifyStatus: 'idle',
    notifyMessage: '',
    notifyFilter: '',
    notifyUpdatedAt: 0,
    notifyPending: false,
    /* 上次成功拉取对应的 topic 集合指纹，避免 All 误用单路缓存。 */
    notifyFetchKey: '',
    /* 任务工单：列表 + 详情缓存 */
    tasks: [],
    tasksStatus: 'idle',
    tasksMessage: '',
    tasksFilter: '',
    tasksUpdatedAt: 0,
    tasksPending: false,
    activeTaskId: '',
    taskDetail: null,
    taskDetailStatus: 'idle',
    taskDetailMessage: ''
  };
  var refreshTask = null;
  var refreshController = null;
  var detailController = null;
  var overviewController = null;
  var overviewTimer = null;
  var notifyController = null;
  var tasksController = null;
  var taskDetailController = null;

  function byId(id) {
    return document.getElementById(id);
  }

  var loginView = byId('login-view');
  var inboxView = byId('inbox-view');
  var loginForm = byId('login-form');
  var loginToken = byId('login-token');
  var loginRemember = byId('login-remember');
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
  var messagesTitle = byId('messages-title');
  var refreshButton = byId('refresh-button');
  var detailContent = byId('detail-content');
  var detailPanel = byId('detail-panel');
  var mainContent = byId('main-content');
  var overviewPanel = byId('overview-panel');
  var overviewStats = byId('overview-stats');
  var overviewRows = byId('overview-rows');
  var overviewSearch = byId('overview-search');
  var overviewSort = byId('overview-sort');
  var overviewStateNode = byId('overview-state');
  var overviewNotice = byId('overview-notice');
  var overviewUpdated = byId('overview-updated');
  var overviewDisclosure = byId('overview-disclosure');
  var overviewShown = byId('overview-shown');
  var overviewRefresh = byId('overview-refresh');
  var createIdentityButton = byId('create-identity-button');
  var backToOverview = byId('back-to-overview');
  var skipLink = byId('skip-link');
  var viewTitle = byId('view-title');
  var statusRegion = byId('status');
  var notifyPanel = byId('notify-panel');
  var notifyRows = byId('notify-rows');
  var notifyStateNode = byId('notify-state');
  var notifyNotice = byId('notify-notice');
  var notifyUpdated = byId('notify-updated');
  var notifyShown = byId('notify-shown');
  var notifyRefresh = byId('notify-refresh');
  var notifyTopicFilter = byId('notify-topic-filter');
  var tasksPanel = byId('tasks-panel');
  var tasksRows = byId('tasks-rows');
  var tasksStateNode = byId('tasks-state');
  var tasksNotice = byId('tasks-notice');
  var tasksUpdated = byId('tasks-updated');
  var tasksShown = byId('tasks-shown');
  var tasksRefresh = byId('tasks-refresh');
  var tasksStateFilter = byId('tasks-state-filter');
  var tasksDetailSection = byId('tasks-detail-section');
  var tasksDetailContent = byId('tasks-detail-content');
  var tasksMobileBack = byId('tasks-mobile-back');
  var tokenModal = byId('token-modal');
  var tokenModalTitle = byId('token-modal-title');
  var tokenValue = byId('token-value');
  var tokenCopyButton = byId('token-copy-button');
  var tokenModalClose = byId('token-modal-close');
  var confirmModal = byId('confirm-modal');
  var confirmModalTitle = byId('confirm-modal-title');
  var confirmModalText = byId('confirm-modal-text');
  var confirmModalRisk = byId('confirm-modal-risk');
  var confirmModalCancel = byId('confirm-modal-cancel');
  var confirmModalConfirm = byId('confirm-modal-confirm');
  var PUSH_TIER3_WARNING =
    'Tier 3 includes message body previews and OTP codes/links in push notifications. That content leaves this server for the ntfy channel.';
  var createModal = byId('create-modal');
  var createName = byId('create-name');
  var createLocalpart = byId('create-localpart');
  var createDomain = byId('create-domain');
  var createModalCancel = byId('create-modal-cancel');
  var createModalSubmit = byId('create-modal-submit');

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
    loginRemember.disabled = !safe;
    loginSubmit.disabled = !safe;
    insecureWarning.hidden = safe;
    return safe;
  }

  /* 401 / 登出共用：清掉通知缓存，避免换 token 后 15s 命中渲染上一主体内容。 */
  function clearNotifyState() {
    state.notifyMessages = [];
    state.notifyStatus = 'idle';
    state.notifyMessage = '';
    state.notifyFilter = '';
    state.notifyUpdatedAt = 0;
    state.notifyFetchKey = '';
    state.notifyPending = false;
  }

  /* 401 / 登出共用：清掉工单缓存，避免换主体后渲染上一会话任务。 */
  function clearTasksState() {
    state.tasks = [];
    state.tasksStatus = 'idle';
    state.tasksMessage = '';
    state.tasksFilter = '';
    state.tasksUpdatedAt = 0;
    state.tasksPending = false;
    state.activeTaskId = '';
    state.taskDetail = null;
    state.taskDetailStatus = 'idle';
    state.taskDetailMessage = '';
  }

  function showLogin(message) {
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    clearNotifyState();
    clearTasksState();
    closeAllModals();
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

  function isAdmin() {
    return Boolean(state.me) && state.me.kind === 'admin';
  }

  function configureSession() {
    inboxView.dataset.session = isAdmin() ? 'admin' : 'identity';
    /* identity 会话下 Overview 相关节点不可见，因此也不在 tab 序里。 */
    backToOverview.hidden = !isAdmin();
    createIdentityButton.hidden = !isAdmin();
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
      failure.body = null;
      try {
        failure.body = await response.json();
      } catch (_parseError) {
        /* body optional */
      }
      throw failure;
    }
    return response.json();
  }

  /* Optional cancel side-effect (e.g. restore a select) — run once when the
     dialog closes unconfirmed (Cancel button or indirect close; F107). */
  var confirmModalOnCancel = null;

  function closeAllModals() {
    tokenModal.hidden = true;
    confirmModal.hidden = true;
    createModal.hidden = true;
    tokenValue.textContent = '';
    tokenModalTitle.textContent = 'Token';
    tokenCopyButton.classList.remove('copied');
    confirmModalTitle.textContent = 'Confirm';
    confirmModalText.textContent = '';
    confirmModalRisk.textContent = '';
    confirmModalRisk.hidden = true;
    confirmModalConfirm.textContent = 'Confirm';
    confirmModalConfirm.onclick = null;
    // F107: an indirect close (background action opening another modal) must
    // still run the pending cancel side-effect (restore tier select) — the
    // callback is consumed exactly once either way.
    var onCancel = confirmModalOnCancel;
    confirmModalOnCancel = null;
    if (onCancel) onCancel();
  }

  function showTokenModal(token, title) {
    closeAllModals();
    tokenModalTitle.textContent = title || 'Token';
    tokenValue.textContent = token;
    tokenModal.hidden = false;
    tokenCopyButton.focus();
  }

  function showCreateModal() {
    if (!isAdmin()) return;
    closeAllModals();
    createName.value = '';
    createLocalpart.value = '';
    var firstAddress = state.identities[0] ? state.identities[0].address : '';
    var separator = firstAddress.lastIndexOf('@');
    createDomain.textContent = separator === -1
      ? window.location.hostname
      : firstAddress.slice(separator + 1);
    createModal.hidden = false;
    createName.focus();
  }

  async function handleCreateSubmit() {
    if (!isAdmin()) return;
    if (!createLocalpart.checkValidity()) {
      createLocalpart.reportValidity();
      return;
    }
    var name = createName.value.trim();
    var localpart = createLocalpart.value.trim();
    createModalSubmit.disabled = true;
    try {
      var payload = await apiJson('/ui/api/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, localpart: localpart || undefined })
      });
      showTokenModal(payload.token);
      loadOverviewCycle({ refresh: false });
    } catch (error) {
      if (error.status === 409) {
        window.alert('address already exists');
      } else if (error.message !== 'session_expired') {
        announce('Could not create the identity. Try again.');
      }
    } finally {
      createModalSubmit.disabled = false;
    }
  }

  async function handleRotateToken(address) {
    try {
      var payload = await apiJson(
        '/ui/api/identities/' + encodeURIComponent(address) + '/token',
        { method: 'POST' }
      );
      showTokenModal(payload.token, 'Rotated Token');
      loadOverviewCycle({ refresh: false });
    } catch (error) {
      if (error.message !== 'session_expired') {
        announce('Could not rotate the token. Try again.');
      }
    }
  }

  function handleDeleteIdentity(address) {
    if (!isAdmin()) return;
    closeAllModals();
    confirmModalTitle.textContent = 'Delete Identity';
    confirmModalText.textContent = 'Delete ' + address + '? This cannot be undone.';
    confirmModalRisk.hidden = true;
    confirmModalConfirm.textContent = 'Delete';
    confirmModal.hidden = false;
    confirmModalConfirm.onclick = async function () {
      confirmModalConfirm.disabled = true;
      try {
        await apiJson('/ui/api/identities/' + encodeURIComponent(address), {
          method: 'DELETE'
        });
        bumpIdentityEpoch();
        state.identities = state.identities.filter(function (identity) {
          return identity.address !== address;
        });
        closeAllModals();
        state.returnAddress = '';
        enterOverview({ announce: address + ' deleted. Back to overview.' });
        loadOverviewCycle({ refresh: false });
      } catch (error) {
        if (error.message !== 'session_expired') {
          announce('Could not delete the identity. Try again.');
        }
      } finally {
        confirmModalConfirm.disabled = false;
      }
    };
    confirmModalConfirm.focus();
  }

  /* Invalidate in-flight overview identity loads so a stale /identities
     response cannot overwrite a local mutation (tier save, delete, …). */
  function bumpIdentityEpoch() {
    state.overviewGen += 1;
  }

  async function savePushContentTier(address, tier, confirmRisk) {
    var body = { pushContentTier: tier };
    if (confirmRisk) body.confirm_risk = true;
    var payload = await apiJson(
      '/ui/api/identities/' + encodeURIComponent(address) + '/push-tier',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    bumpIdentityEpoch();
    state.identities = state.identities.map(function (identity) {
      if (identity.address !== address) return identity;
      return Object.assign({}, identity, {
        pushContentTier: payload.pushContentTier,
        pushContentTierWarning: payload.warning
      });
    });
    return payload;
  }

  function handlePushTierChange(address, selectEl) {
    if (!isAdmin()) return;
    // F126: a tier PUT is already in flight for this address (an overview
    // rerender can replace the selector while the tier-3 dialog waits) —
    // reject the competing change so the persisted tier follows the user's
    // choice, not request timing.
    if (state.tierPending[address]) return;
    var previous = Number(selectEl.dataset.currentTier || '1');
    var next = Number(selectEl.value);
    if (next === previous) return;

    function restore() {
      selectEl.value = String(previous);
    }

    async function apply(tier, confirmRisk) {
      // F127: the tier-3 dialog can outlive an overview rerender — the user may
      // have started a competing change on the replacement selector before this
      // confirmation ran. apply() bypasses the handlePushTierChange entry lock,
      // so recheck here: the in-flight change wins, this stale one is dropped.
      if (state.tierPending[address]) {
        announce('Another push content change is already in progress for ' + address + '.');
        return;
      }
      state.tierPending[address] = true;
      selectEl.disabled = true;
      // F126: render the pending state immediately — the modal background is
      // not inert, so a row recreated mid-flight must come back disabled, or
      // keyboard users can start a competing PUT on the replacement select.
      if (state.scope === 'overview') renderOverviewRows();
      try {
        await savePushContentTier(address, tier, confirmRisk);
        selectEl.dataset.currentTier = String(tier);
        announce('Push content set to tier ' + tier + ' for ' + address + '.');
        renderOverviewRows();
        // Restart overview only while still on Overview: unstick Refresh after
        // bumpIdentityEpoch, but do not revive overview polling after openAddress.
        if (state.scope === 'overview') {
          loadOverviewCycle({ refresh: false });
        }
      } catch (error) {
        if (
          error.status === 400 &&
          error.body &&
          error.body.error === 'confirm_risk_required'
        ) {
          // Server rejected — no ambiguous state.
          restore();
          announce('Tier 3 requires explicit risk confirmation.');
        } else if (error.message === 'session_expired') {
          restore();
        } else {
          // Fuzzy failure (network/parse/5xx): PUT may already have persisted.
          // Invalidate in-flight overview identity loads, then re-fetch.
          bumpIdentityEpoch();
          var recoveryGen = state.overviewGen;
          try {
            var payload = await apiJson('/ui/api/identities');
            if (recoveryGen !== state.overviewGen) return;
            state.identities = Array.isArray(payload.identities) ? payload.identities : [];
            var row = state.identities.find(function (identity) {
              return identity.address === address;
            });
            if (!row) {
              restore();
              announce('Could not update push content tier. Try again.');
            } else {
              var authoritative =
                row.pushContentTier === 2 || row.pushContentTier === 3
                  ? row.pushContentTier
                  : 1;
              selectEl.value = String(authoritative);
              selectEl.dataset.currentTier = String(authoritative);
              announce(
                'Push content tier is tier ' +
                  authoritative +
                  ' for ' +
                  address +
                  ' (refreshed).',
              );
              renderOverviewRows();
            }
          } catch (_refreshErr) {
            if (recoveryGen !== state.overviewGen) return;
            restore();
            announce('Could not update push content tier. Try again.');
          }
        }
      } finally {
        delete state.tierPending[address];
        selectEl.disabled = false;
        // Re-render so a select recreated mid-flight drops disabled correctly.
        if (state.scope === 'overview') renderOverviewRows();
      }
    }

    if (next !== 3) {
      apply(next, false);
      return;
    }

    closeAllModals();
    confirmModalTitle.textContent = 'Enable sensitive push content';
    confirmModalText.textContent =
      'Enable tier 3 for ' + address + '? Body previews and OTP codes/links will leave this server.';
    confirmModalRisk.textContent = PUSH_TIER3_WARNING;
    confirmModalRisk.hidden = false;
    confirmModalConfirm.textContent = 'Enable tier 3';
    confirmModal.hidden = false;
    // Restore the previous tier if the dialog closes unconfirmed (Cancel or an
    // indirect close runs it via closeAllModals); the success path clears it.
    confirmModalOnCancel = function () {
      restore();
    };
    confirmModalConfirm.onclick = async function () {
      // Disable both actions for the in-flight PUT so Cancel cannot restore
      // the select while a successful response still enables tier 3.
      confirmModalConfirm.disabled = true;
      confirmModalCancel.disabled = true;
      try {
        await apply(3, true);
        // F107: confirmed — consume the pending restore before closeAllModals
        // would run it and drop the select back to the old tier.
        confirmModalOnCancel = null;
        closeAllModals();
      } finally {
        confirmModalConfirm.disabled = false;
        confirmModalCancel.disabled = false;
      }
    };
    confirmModalConfirm.focus();
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

  function formatDay(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }

  function formatClock(value, withSeconds) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    var options = withSeconds
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
  }

  function formatAgo(value) {
    var when = Date.parse(value);
    if (Number.isNaN(when)) return '—';
    var seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' h ago';
    return Math.round(hours / 24) + ' d ago';
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

  /* ---- scope 迁移：任一时刻恰好一个可见 <main>（overview / notifications / tasks / inbox） ---- */
  function applyScope(next, options) {
    var opts = options || {};
    var overviewActive = next === 'overview';
    var notifyActive = next === 'notifications';
    var tasksActive = next === 'tasks';
    var inboxActive = next === 'inbox';
    state.scope = next;
    inboxView.dataset.scope = next;
    overviewPanel.hidden = !overviewActive;
    notifyPanel.hidden = !notifyActive;
    tasksPanel.hidden = !tasksActive;
    mainContent.hidden = !inboxActive;
    viewTitle.textContent = overviewActive
      ? 'Overview'
      : notifyActive
        ? 'Notifications'
        : tasksActive
          ? 'Tasks'
          : 'Inbox';
    document.title = overviewActive
      ? 'OpenAgent Overview'
      : notifyActive
        ? 'OpenAgent Notifications'
        : tasksActive
          ? 'OpenAgent Tasks'
          : 'OpenAgent Inbox';
    skipLink.textContent = overviewActive
      ? 'Skip to overview'
      : notifyActive
        ? 'Skip to notifications'
        : tasksActive
          ? 'Skip to tasks'
          : 'Skip to inbox';
    skipLink.setAttribute(
      'href',
      overviewActive
        ? '#overview-panel'
        : notifyActive
          ? '#notify-panel'
          : tasksActive
            ? '#tasks-panel'
            : '#main-content'
    );
    if (overviewActive) inboxView.dataset.mobileView = 'overview';
    else if (notifyActive) inboxView.dataset.mobileView = 'notifications';
    else if (tasksActive) inboxView.dataset.mobileView = 'tasks-list';
    renderIdentities();
    if (opts.announce) announce(opts.announce);
  }

  /* 侧栏地址项与移动 <select> 是 Overview / Notifications / Tasks 之外的入口：在非 inbox
     scope 下必须走 openAddress（切 scope、播报、聚焦），否则会在不可见的 inbox
     里取消息、画面却停在当前面板。 */
  function activateAddress(address) {
    if (state.scope === 'overview' || state.scope === 'notifications' || state.scope === 'tasks') {
      openAddress(address);
      return;
    }
    selectIdentity(address);
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

    if (isAdmin()) {
      /* 空串永不可能是合法地址，所以它是安全的"回总览"哨兵值。 */
      var overviewOption = document.createElement('option');
      overviewOption.value = '';
      overviewOption.textContent = 'Overview — all addresses';
      overviewOption.selected = state.scope === 'overview';
      mobileIdentity.append(overviewOption);
    }

    /* 通知/工单面板哨兵：合法地址不会以双下划线开头。 */
    var notifyOption = document.createElement('option');
    notifyOption.value = '__notifications__';
    notifyOption.textContent = 'Notifications — push history';
    notifyOption.selected = state.scope === 'notifications';
    mobileIdentity.append(notifyOption);

    var tasksOption = document.createElement('option');
    tasksOption.value = '__tasks__';
    tasksOption.textContent = 'Tasks — ticket board';
    tasksOption.selected = state.scope === 'tasks';
    mobileIdentity.append(tasksOption);

    state.identities.forEach(function (identity) {
      var option = document.createElement('option');
      option.value = identity.address;
      option.textContent = identity.name ? identity.name + ' — ' + identity.address : identity.address;
      option.selected = state.scope === 'inbox' && identity.address === state.activeAddress;
      mobileIdentity.append(option);
    });

    if (isAdmin()) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'identity-button overview-nav';
      button.setAttribute('aria-current', state.scope === 'overview' ? 'true' : 'false');
      var overviewName = document.createElement('strong');
      overviewName.textContent = 'Overview';
      var overviewHint = document.createElement('span');
      overviewHint.textContent = 'All addresses';
      button.append(overviewName, overviewHint);
      button.addEventListener('click', function () {
        enterOverview({ announce: 'Back to overview' });
      });
      item.append(button);
      identityList.append(item);
    }

    var notifyItem = document.createElement('li');
    var notifyButton = document.createElement('button');
    notifyButton.type = 'button';
    notifyButton.className = 'identity-button overview-nav';
    notifyButton.setAttribute('aria-current', state.scope === 'notifications' ? 'true' : 'false');
    var notifyName = document.createElement('strong');
    notifyName.textContent = 'Notifications';
    var notifyHint = document.createElement('span');
    notifyHint.textContent = 'Push history';
    notifyButton.append(notifyName, notifyHint);
    notifyButton.addEventListener('click', function () {
      enterNotifications({ announce: 'Opened notifications' });
    });
    notifyItem.append(notifyButton);
    identityList.append(notifyItem);

    var tasksItem = document.createElement('li');
    var tasksButton = document.createElement('button');
    tasksButton.type = 'button';
    tasksButton.className = 'identity-button overview-nav';
    tasksButton.setAttribute('aria-current', state.scope === 'tasks' ? 'true' : 'false');
    var tasksName = document.createElement('strong');
    tasksName.textContent = 'Tasks';
    var tasksHint = document.createElement('span');
    tasksHint.textContent = 'Ticket board';
    tasksButton.append(tasksName, tasksHint);
    tasksButton.addEventListener('click', function () {
      enterTasks({ announce: 'Opened tasks' });
    });
    tasksItem.append(tasksButton);
    identityList.append(tasksItem);

    filteredIdentities().forEach(function (identity) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'identity-button';
      button.setAttribute(
        'aria-current',
        state.scope === 'inbox' && identity.address === state.activeAddress ? 'true' : 'false'
      );
      var name = document.createElement('strong');
      name.textContent = identity.name || identity.address.split('@')[0];
      var address = document.createElement('span');
      address.textContent = identity.address;
      button.append(name, address);
      button.addEventListener('click', function () {
        activateAddress(identity.address);
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

  /* ---- Overview 渲染 ---- */
  function statsRow(address) {
    var payload = state.overview;
    if (!payload || !Array.isArray(payload.addresses)) return null;
    for (var index = 0; index < payload.addresses.length; index += 1) {
      if (payload.addresses[index].address === address) return payload.addresses[index];
    }
    return null;
  }

  function countParts(row, key) {
    /* 数值的诚实呈现：截断影响到该行时只给下界，下界为 0 时说 Unknown。 */
    if (!row) return { text: state.overviewStatus === 'loading' || state.overviewStatus === 'idle' ? 'Loading…' : 'Unavailable', flat: true };
    var value = row[key];
    if (row.complete) return { text: formatNumber(value), unit: key === 'unseen' ? 'unseen' : 'msgs', flat: value === 0 };
    if (value > 0) {
      return {
        text: '≥' + formatNumber(value),
        unit: key === 'unseen' ? 'unseen' : 'msgs',
        title: 'Lower bound — this scan hit its recipient limit.'
      };
    }
    return { text: 'Unknown', flat: true, title: 'Not counted — this scan hit its recipient limit.' };
  }

  /* 聚合卡片与行级共用同一套界向口径：totals.exact===false 时 IN WINDOW /
     UNSEEN / ACTIVE 24H 都是下界，下界为 0 就只能说 Unknown。 */
  function boundParts(value, exact) {
    if (exact) return { text: formatNumber(value) };
    if (value > 0) {
      return {
        text: '≥' + formatNumber(value),
        title: 'Lower bound — this scan hit its recipient limit.'
      };
    }
    return { text: 'Unknown', title: 'Not counted — this scan hit its recipient limit.' };
  }

  function appendCell(parent, labelText, parts, extra) {
    var cell = document.createElement('span');
    cell.className = 'cell';
    var label = document.createElement('span');
    label.className = 'cell-label';
    label.textContent = labelText;
    var value = document.createElement('span');
    value.className = 'cell-value' + (parts.flat ? ' row-flat' : '');
    if (extra) value.append(extra);
    value.append(document.createTextNode(parts.text));
    if (parts.title) value.title = parts.title;
    cell.append(label, value);
    if (parts.unit) {
      var unit = document.createElement('span');
      unit.className = 'cell-unit';
      unit.textContent = parts.unit;
      cell.append(unit);
    }
    parent.append(cell);
    return parts.text + (parts.unit ? ' ' + parts.unit : '');
  }

  function isActiveRow(row) {
    if (!row || !row.lastReceivedAt || !state.overview || !state.overview.totals) return false;
    var since = Date.parse(state.overview.totals.recentSince);
    return !Number.isNaN(since) && Date.parse(row.lastReceivedAt) >= since;
  }

  function overviewModels() {
    var needle = state.overviewFilter.toLowerCase();
    var models = [];
    state.identities.forEach(function (identity) {
      if (needle &&
        identity.address.toLowerCase().indexOf(needle) === -1 &&
        (identity.name || '').toLowerCase().indexOf(needle) === -1) return;
      models.push({ identity: identity, stats: statsRow(identity.address) });
    });
    return models;
  }

  /* Unknown / Unavailable / 无命中的行始终排在同组末尾。 */
  function sortRank(model) {
    if (!model.stats) return 1;
    if (!model.stats.complete && model.stats.count === 0) return 1;
    if (state.overviewSort.key === 'last' && !model.stats.lastReceivedAt) return 1;
    return 0;
  }

  function sortValue(model) {
    var key = state.overviewSort.key;
    var stats = model.stats;
    if (key === 'address') return model.identity.address.toLowerCase();
    if (key === 'name') return (model.identity.name || '').toLowerCase();
    if (key === 'created') return Date.parse(model.identity.createdAt) || 0;
    if (key === 'count') return stats ? stats.count : -1;
    if (key === 'unseen') return stats ? stats.unseen : -1;
    return stats && stats.lastReceivedAt ? Date.parse(stats.lastReceivedAt) : 0;
  }

  function sortedModels() {
    var direction = state.overviewSort.dir === 'asc' ? 1 : -1;
    return overviewModels().slice().sort(function (left, right) {
      var rank = sortRank(left) - sortRank(right);
      if (rank !== 0) return rank;
      var a = sortValue(left);
      var b = sortValue(right);
      if (a < b) return -1 * direction;
      if (a > b) return 1 * direction;
      var created = (Date.parse(right.identity.createdAt) || 0) - (Date.parse(left.identity.createdAt) || 0);
      if (created !== 0) return created;
      return left.identity.address < right.identity.address ? -1 : 1;
    });
  }

  function buildSortControls() {
    overviewSort.replaceChildren();
    SORT_COLUMNS.forEach(function (column) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.dataset.sortKey = column.key;
      button.addEventListener('click', function () {
        if (state.overviewSort.key === column.key) {
          state.overviewSort.dir = state.overviewSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.overviewSort.key = column.key;
          state.overviewSort.dir = column.key === 'address' || column.key === 'name' ? 'asc' : 'desc';
        }
        renderOverview();
      });
      overviewSort.append(button);
    });
  }

  function renderSortControls() {
    Array.prototype.forEach.call(overviewSort.children, function (button) {
      var column = SORT_COLUMNS.filter(function (candidate) {
        return candidate.key === button.dataset.sortKey;
      })[0];
      var active = state.overviewSort.key === button.dataset.sortKey;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.textContent = active
        ? column.label + (state.overviewSort.dir === 'asc' ? ' ▲' : ' ▼')
        : column.label;
    });
  }

  function renderOverviewStats() {
    overviewStats.replaceChildren();
    var payload = state.overview;
    var scan = payload ? payload.scan : null;
    var totals = payload ? payload.totals : null;
    var pending = state.overviewStatus === 'loading' || state.overviewStatus === 'idle';
    var fallback = { text: pending ? 'Loading…' : 'Unavailable' };
    var exact = !totals || totals.exact !== false;

    function card(label, parts) {
      var wrapper = document.createElement('div');
      wrapper.className = 'stat-card';
      var labelNode = document.createElement('span');
      labelNode.className = 'stat-label';
      labelNode.textContent = label;
      var valueNode = document.createElement('span');
      valueNode.className = 'stat-value';
      valueNode.textContent = parts.text;
      if (parts.title) valueNode.title = parts.title;
      wrapper.append(labelNode, valueNode);
      overviewStats.append(wrapper);
    }

    /* 地址数是身份派生量，永远精确。 */
    card('Addresses', {
      text: totals ? formatNumber(totals.addresses) : String(state.identities.length)
    });
    /* skipped:true 时窗口派生量未被观测，整张卡片不进 DOM。 */
    if (!scan || !scan.skipped) {
      var windowed = fallback;
      if (totals && scan && scan.scanned !== null) {
        windowed = boundParts(totals.matchedInWindow, exact);
        /* Unknown 是"没数过"，再除以窗口大小没有意义；有下界时才写 N / 窗口。 */
        if (windowed.text !== 'Unknown') {
          windowed.text += ' / ' + formatNumber(scan.scanned);
        }
      }
      card('In window', windowed);
    }
    card('Unseen', totals ? boundParts(totals.unseenInWindow, exact) : fallback);
    card('Active 24h', totals ? boundParts(totals.activeAddresses, exact) : fallback);
  }

  function renderOverviewMeta() {
    var payload = state.overview;
    overviewPanel.classList.toggle('is-ready', state.overviewStatus === 'ready');
    overviewPanel.classList.toggle('is-stale', state.overviewStatus === 'stale');
    overviewPanel.classList.toggle(
      'is-error',
      state.overviewStatus === 'unavailable' || state.overviewStatus === 'error'
    );

    if (!payload) {
      overviewUpdated.textContent = state.overviewStatus === 'loading' ? 'Counting messages…' : '';
    } else if (payload.scan && payload.scan.skipped) {
      overviewUpdated.textContent = 'Updated ' + formatClock(payload.generatedAt, true);
    } else {
      var line = 'Updated ' + formatClock(payload.generatedAt, true) +
        ' · newest ' + formatNumber(payload.scan.scanned) + ' of ' +
        formatNumber(payload.scan.mailboxTotal) + ' in the mailbox';
      if (state.overviewStatus === 'stale' && payload.refreshError) {
        line = 'Counts from ' + formatClock(payload.generatedAt, false) + ' · last refresh failed';
      }
      overviewUpdated.textContent = line;
    }

    var exact = !payload || !payload.totals || payload.totals.exact !== false;
    overviewDisclosure.hidden = exact;
    overviewDisclosure.textContent = exact
      ? ''
      : 'Some counts are incomplete for messages with very large recipient lists (shown as ≥ or Unknown).';

    overviewNotice.hidden = !state.overviewMessage;
    overviewNotice.textContent = state.overviewMessage;
  }

  function renderOverviewRows() {
    overviewRows.replaceChildren();
    var models = sortedModels();
    overviewShown.textContent = state.overviewFilter
      ? models.length + ' of ' + state.identities.length
      : models.length + ' shown';

    if (state.identities.length === 0) {
      overviewStateNode.textContent =
        'No addresses yet. Create one with the REST API or the MCP server, then it appears here.';
      return;
    }
    if (models.length === 0) {
      overviewStateNode.textContent = 'No addresses match your filter.';
      return;
    }
    overviewStateNode.textContent = '';

    models.forEach(function (model) {
      var row = model.stats;
      var rowNode = document.createElement('div');
      rowNode.className = 'overview-row';
      rowNode.dataset.address = model.identity.address;
      rowNode.setAttribute('aria-current', 'false');

      // F66: navigation is a sibling of tier/actions, not an ancestor of <select>.
      var navNode = document.createElement('div');
      navNode.className = 'overview-row-nav';
      navNode.setAttribute('role', 'button');
      navNode.tabIndex = 0;

      var identityCell = document.createElement('span');
      identityCell.className = 'cell';
      var name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = model.identity.name || model.identity.address.split('@')[0];
      var addressNode = document.createElement('span');
      addressNode.className = 'row-address';
      addressNode.textContent = model.identity.address;
      identityCell.append(name, addressNode);
      if (row && row.complete && row.count === 0) {
        var note = document.createElement('span');
        note.className = 'row-note';
        note.textContent = '(no mail in the current window)';
        identityCell.append(note);
      }
      navNode.append(identityCell);

      var tokenCell = document.createElement('span');
      tokenCell.className = 'cell token-cell';
      var tokenLabel = document.createElement('span');
      tokenLabel.className = 'cell-label';
      tokenLabel.textContent = 'Token';
      var tokenStatus = document.createElement('span');
      tokenStatus.className = 'cell-value' + (model.identity.hasToken ? '' : ' row-flat');
      var tokenDot = document.createElement('span');
      tokenDot.className = 'token-dot' + (model.identity.hasToken ? ' has-token' : '');
      tokenStatus.append(tokenDot, document.createTextNode(model.identity.hasToken ? 'Set' : 'None'));
      tokenCell.append(tokenLabel, tokenStatus);
      navNode.append(tokenCell);

      var countText = appendCell(navNode, 'Messages', countParts(row, 'count'));
      var unseenText = appendCell(navNode, 'Unseen', countParts(row, 'unseen'));

      var dot = null;
      if (isActiveRow(row)) {
        dot = document.createElement('span');
        dot.className = 'active-dot';
      }
      var lastParts = row && row.lastReceivedAt
        ? { text: formatAgo(row.lastReceivedAt) }
        : { text: row ? '—' : 'Unavailable', flat: true };
      var lastText = appendCell(navNode, 'Last', lastParts, dot);
      var createdText = appendCell(navNode, 'Created', { text: formatDay(model.identity.createdAt) });

      var currentTier = model.identity.pushContentTier === 2 || model.identity.pushContentTier === 3
        ? model.identity.pushContentTier
        : 1;
      var ariaParts = [
        model.identity.name || model.identity.address,
        model.identity.address,
        model.identity.hasToken ? 'token set' : 'no token',
        countText,
        unseenText,
        'last ' + lastText,
        'created ' + createdText,
        'push tier ' + currentTier
      ];
      navNode.setAttribute('aria-label', ariaParts.join(', '));
      navNode.addEventListener('click', function () {
        openAddress(model.identity.address);
      });
      navNode.addEventListener('keydown', function (event) {
        if (event.target !== navNode || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openAddress(model.identity.address);
      });
      rowNode.append(navNode);

      if (isAdmin()) {
        var tierCell = document.createElement('span');
        tierCell.className = 'cell push-tier-cell';
        var tierLabelNode = document.createElement('span');
        tierLabelNode.className = 'cell-label';
        tierLabelNode.textContent = 'Push content';
        var tierSelect = document.createElement('select');
        tierSelect.className = 'push-tier-select';
        tierSelect.setAttribute('aria-label', 'Push content tier for ' + model.identity.address);
        tierSelect.dataset.currentTier = String(currentTier);
        if (state.tierPending[model.identity.address]) {
          tierSelect.disabled = true;
        }
        [
          { value: 1, label: '1 · interrupt only' },
          { value: 2, label: '2 · + subject / from' },
          { value: 3, label: '3 · + body / OTP (sensitive)' }
        ].forEach(function (optionDef) {
          var option = document.createElement('option');
          option.value = String(optionDef.value);
          option.textContent = optionDef.label;
          if (optionDef.value === currentTier) option.selected = true;
          tierSelect.append(option);
        });
        tierSelect.addEventListener('click', function (event) {
          event.stopPropagation();
        });
        tierSelect.addEventListener('change', function (event) {
          event.stopPropagation();
          handlePushTierChange(model.identity.address, tierSelect);
        });
        tierCell.append(tierLabelNode, tierSelect);
        if (currentTier === 3) {
          var riskHint = document.createElement('span');
          riskHint.className = 'push-tier-hint';
          riskHint.textContent = 'Body/OTP leave server';
          riskHint.title = model.identity.pushContentTierWarning || PUSH_TIER3_WARNING;
          tierCell.append(riskHint);
        }
        rowNode.append(tierCell);

        var actionsCell = document.createElement('span');
        actionsCell.className = 'cell row-actions';
        var actionsLabel = document.createElement('span');
        actionsLabel.className = 'cell-label';
        actionsLabel.textContent = 'Actions';
        var rotateButton = document.createElement('button');
        rotateButton.type = 'button';
        rotateButton.className = 'quiet row-action';
        rotateButton.textContent = 'Rotate';
        rotateButton.addEventListener('click', function (event) {
          event.stopPropagation();
          handleRotateToken(model.identity.address);
        });
        var deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'quiet row-action delete-action';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', function (event) {
          event.stopPropagation();
          handleDeleteIdentity(model.identity.address);
        });
        actionsCell.append(actionsLabel, rotateButton, deleteButton);
        rowNode.append(actionsCell);
      }

      overviewRows.append(rowNode);
    });
  }

  function updateOverviewRefreshButton() {
    if (state.overviewPending) {
      overviewRefresh.disabled = true;
      overviewRefresh.textContent = 'Refreshing…';
      return;
    }
    overviewRefresh.disabled = false;
    var payload = state.overview;
    if (state.overviewStatus === 'stale' && payload && payload.refreshError && payload.retryAfterMs) {
      /* 冷却期不假装正在刷新：明说下一次重试还有几秒。 */
      overviewRefresh.textContent = 'Retrying in ' + Math.ceil(payload.retryAfterMs / 1000) + 's…';
      return;
    }
    overviewRefresh.textContent =
      state.overviewStatus === 'unavailable' || state.overviewStatus === 'error' ? 'Retry' : 'Refresh';
  }

  function renderOverview() {
    renderOverviewMeta();
    renderOverviewStats();
    renderSortControls();
    renderOverviewRows();
    updateOverviewRefreshButton();
  }

  function rowButtonFor(address) {
    // Focus the row's nav hit-target (role=button), not the neutral outer row (F66).
    var rows = overviewRows.children;
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index].dataset.address === address) {
        return rows[index].querySelector('.overview-row-nav') || rows[index];
      }
    }
    return null;
  }

  function cancelOverviewPoll() {
    if (overviewTimer !== null) {
      window.clearTimeout(overviewTimer);
      overviewTimer = null;
    }
  }

  function cancelOverview() {
    cancelOverviewPoll();
    if (overviewController) {
      overviewController.abort();
      overviewController = null;
    }
    state.overviewPending = false;
    state.overviewPolls = 0;
    state.overviewLoadingSince = 0;
  }

  /* 服务端给的 retryAfterMs 是"最早可再来"的时刻，客户端必须遵守它。 */
  function scheduleOverviewPoll(retryAfterMs) {
    cancelOverviewPoll();
    var delay = Math.max(retryAfterMs || 1500, 1000);
    state.overviewRetryAt = Date.now() + delay;
    overviewTimer = window.setTimeout(function () {
      overviewTimer = null;
      loadOverviewCycle({ refresh: false });
    }, delay);
  }

  function readyAnnouncement(payload) {
    var totals = payload.totals;
    if (payload.scan && payload.scan.skipped) {
      return 'Overview loaded: 0 addresses.';
    }
    return 'Overview loaded: ' + totals.addresses + ' addresses, ' +
      totals.matchedInWindow + ' messages in the newest ' + payload.scan.scanned +
      ', ' + totals.unseenInWindow + ' unseen.';
  }

  function applyOverviewPayload(payload) {
    cancelOverviewPoll();
    if (payload.status === 'loading') {
      /* 202 不覆盖上一次的载荷：表格继续显示旧数值，而不是掉回 0。 */
      state.overviewStatus = 'loading';
      state.overviewMessage = '';
      if (!state.overviewLoadingSince) state.overviewLoadingSince = Date.now();
      state.overviewPolls += 1;
      if (state.overviewPolls >= POLL_LIMIT ||
        Date.now() - state.overviewLoadingSince > POLL_WINDOW_MS) {
        state.overviewStatus = 'unavailable';
        state.overviewMessage = 'Message counts are taking too long.';
        announce('Message counts are taking too long.');
        return;
      }
      scheduleOverviewPoll(payload.retryAfterMs);
      announce('Overview counts are still loading.');
      return;
    }

    state.overview = payload;
    state.overviewStatus = payload.status === 'stale' ? 'stale' : 'ready';
    state.overviewPolls = 0;
    state.overviewLoadingSince = 0;
    state.overviewMessage = '';

    if (state.overviewStatus === 'ready') {
      announce(readyAnnouncement(payload));
      return;
    }
    if (payload.refreshError) {
      state.overviewMessage = 'The last refresh failed. Showing the previous counts.';
      announce('Showing counts from ' + formatClock(payload.generatedAt, false) + '. Refresh failed.');
    } else {
      announce(readyAnnouncement(payload));
    }
    /* 唯一轮询规则：只有在途 flight 或待重试的失败才安排下一周期。 */
    if (payload.revalidating || payload.refreshError) scheduleOverviewPoll(payload.retryAfterMs);
  }

  function applyOverviewError(error) {
    cancelOverviewPoll();
    if (error.message === 'session_expired') return;
    if (error.status === 500) {
      state.overviewStatus = 'error';
      state.overviewMessage = 'Addresses could not be read from the server.';
      announce('Addresses could not be read from the server.');
      return;
    }
    state.overviewStatus = 'unavailable';
    state.overviewMessage = 'Message counts are unavailable right now.';
    announce('Overview counts are unavailable. Addresses are listed without counts.');
  }

  function handleIdentitiesError(error) {
    if (error.message === 'session_expired') return;
    state.overviewStatus = 'error';
    state.overviewMessage = 'Addresses could not be read from the server.';
    announce('Addresses could not be read from the server.');
    renderOverview();
  }

  /* 新一轮 /identities 里活动地址消失了（被删/被 retention 清掉）：不能把用户留在
     一个失效的 inbox 里反复报"邮件加载失败"，清掉活动状态并回 Overview + 播报。 */
  function reconcileActiveAddress() {
    if (!state.activeAddress) return;
    var survivors = state.identities.filter(function (identity) {
      return identity.address === state.activeAddress;
    });
    if (survivors.length) return;
    var lost = state.activeAddress;
    state.activeAddress = '';
    state.messages = [];
    state.returnAddress = '';
    clearDetail();
    renderMessages();
    if (state.scope !== 'inbox') return;
    enterOverview({ announce: lost + ' is no longer available. Back to overview.' });
  }

  /* inbox 里触发身份刷新的时机：admin 每次手动 Refresh。停在 inbox 时 Overview
     周期是停掉的（cancelOverview），所以这是"活动地址被删"能被发现的那一刻。 */
  function refreshInboxIdentities() {
    // Same epoch as loadOverviewCycle: a tier save mid-flight must not be
    // overwritten by a slower inbox identity refresh.
    var generation = state.overviewGen;
    apiJson('/ui/api/identities').then(function (payload) {
      if (state.scope !== 'inbox') return;
      if (generation !== state.overviewGen) return;
      state.identities = Array.isArray(payload.identities) ? payload.identities : [];
      renderIdentities();
      reconcileActiveAddress();
    }).catch(function () {
      /* 名单取不到就沿用旧名单：邮件本身的失败由 refreshMessages 自己报。 */
    });
  }

  /* 一个 Overview 周期：同一代际下并发发起两条请求，且两条各自独立落地 ——
     /identities 一到就渲染地址骨架，绝不等 /overview 的扫描预算。 */
  function loadOverviewCycle(options) {
    var opts = options || {};
    var generation = ++state.overviewGen;
    cancelOverviewPoll();
    if (overviewController) overviewController.abort();
    overviewController = new AbortController();
    var signal = overviewController.signal;
    state.overviewPending = true;
    state.overviewCycleGen = generation;
    updateOverviewRefreshButton();

    var identitiesPromise = apiJson('/ui/api/identities', { signal: signal });
    var overviewPromise = apiJson(
      opts.refresh ? '/ui/api/overview?refresh=1' : '/ui/api/overview',
      { signal: signal }
    );

    identitiesPromise.then(function (payload) {
      if (generation !== state.overviewGen) return;
      state.identities = Array.isArray(payload.identities) ? payload.identities : [];
      /* 侧栏与总览行都吃这份名单，两边都得重画（只重画总览会让侧栏一直空着）。 */
      renderIdentities();
      renderOverview();
      reconcileActiveAddress();
    }).catch(function (error) {
      if (generation !== state.overviewGen) return;
      handleIdentitiesError(error);
    });

    overviewPromise.then(function (payload) {
      if (generation !== state.overviewGen) {
        // Superseded by bumpIdentityEpoch or a newer cycle: never write data,
        // but if no live cycle owns the current gen, clear a stuck Refresh.
        if (state.overviewPending && state.overviewCycleGen !== state.overviewGen) {
          state.overviewPending = false;
          updateOverviewRefreshButton();
        }
        return;
      }
      state.overviewPending = false;
      applyOverviewPayload(payload);
      renderOverview();
    }).catch(function (error) {
      if (generation !== state.overviewGen) {
        if (state.overviewPending && state.overviewCycleGen !== state.overviewGen) {
          state.overviewPending = false;
          updateOverviewRefreshButton();
        }
        return;
      }
      state.overviewPending = false;
      if (error.name === 'AbortError') return;
      applyOverviewError(error);
      renderOverview();
    });
  }

  /* Overview 面板在 375 px 下 min-height 就有 calc(100vh - 66px)，顶上还压着 topbar 与
     Address 标签，所以普通 focus() 会为了"把整块拉进视口"往下滚一截，首屏看不到 topbar/
     Sign out/Address（CONSOLIDATED §1.4 要求首屏从 topbar 开始，A66 要求 logo 可见）。
     面板只是个 tabindex="-1" 的落焦点，本来就不需要滚动，所以这条路径一律 preventScroll。 */
  function focusOverviewPanel() {
    overviewPanel.focus({ preventScroll: true });
  }

  function enterOverview(options) {
    var opts = options || {};
    cancelOverviewPoll();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('overview', { announce: opts.announce });
    renderOverview();
    /* 两条聚焦路径分开处理：从 inbox 返回时焦点回到原来那一行，那一行可能在长表格深处，
       必须照常滚动过去；没有返回行时焦点落在面板上，不滚。 */
    var returnRow = opts.returnTo ? rowButtonFor(opts.returnTo) : null;
    if (returnRow) returnRow.focus();
    else focusOverviewPanel();
    /* 唯一新鲜度口径：generatedAt 的本机年龄 <15 s 就直接重渲染，0 请求。 */
    var age = state.overview
      ? Math.max(0, Date.now() - Date.parse(state.overview.generatedAt))
      : Infinity;
    if (state.overviewStatus === 'ready' && age < FRESH_MS) return;
    loadOverviewCycle({ refresh: false });
  }

  function openAddress(address) {
    state.returnAddress = address;
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('inbox');
    inboxView.dataset.mobileView = 'list';
    announce('Opened ' + address);
    messagesTitle.focus();
    selectIdentity(address);
  }

  /* ---- 通知记录面板（放在 overview cycle 切片之后，避免污染其 await 断言） ---- */
  function focusNotifyPanel() {
    notifyPanel.focus({ preventScroll: true });
  }

  /* priority → 档位文案（与 lib/notify.ts priority() 互逆；未知值不强行标 normal）。 */
  function tierFromPriority(priority) {
    if (priority === 5) return 'urgent';
    if (priority === 1) return 'low';
    if (priority === 3) return 'normal';
    return 'unknown';
  }

  function formatNotifyChannel(topic) {
    if (topic === 'user-alerts') return 'User alerts';
    if (topic === 'user-low') return 'User low';
    return topic;
  }

  /* 本会话允许查询的逻辑 topic：identity 只打 self；admin 用 identities 派生，不另开列表 API。 */
  function notifyTopicsForSession() {
    if (!isAdmin()) return ['self'];
    var topics = ['user-alerts', 'user-low'];
    state.identities.forEach(function (identity) {
      var localpart = identity.address.split('@')[0];
      if (localpart) topics.push('agent:' + localpart);
    });
    return topics;
  }

  function notifyTopicsToFetch() {
    return state.notifyFilter ? [state.notifyFilter] : notifyTopicsForSession();
  }

  function notifyFetchKey() {
    return notifyTopicsToFetch().join('|');
  }

  function cancelNotifyLoad() {
    if (notifyController) {
      notifyController.abort();
      notifyController = null;
    }
    state.notifyPending = false;
  }

  function filteredNotifyMessages() {
    if (!state.notifyFilter) return state.notifyMessages;
    return state.notifyMessages.filter(function (row) {
      return row.topic === state.notifyFilter;
    });
  }

  function populateNotifyTopicFilter() {
    var previous = state.notifyFilter;
    notifyTopicFilter.replaceChildren();
    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'All channels';
    notifyTopicFilter.append(all);
    if (!isAdmin()) {
      notifyTopicFilter.hidden = true;
      state.notifyFilter = '';
      return;
    }
    notifyTopicFilter.hidden = false;
    ['user-alerts', 'user-low'].forEach(function (topic) {
      var option = document.createElement('option');
      option.value = topic;
      option.textContent = formatNotifyChannel(topic);
      notifyTopicFilter.append(option);
    });
    state.identities.forEach(function (identity) {
      var localpart = identity.address.split('@')[0];
      if (!localpart) return;
      var topic = 'agent:' + localpart;
      var option = document.createElement('option');
      option.value = topic;
      option.textContent = topic;
      notifyTopicFilter.append(option);
    });
    var stillValid = previous === '' || Array.prototype.some.call(notifyTopicFilter.options, function (opt) {
      return opt.value === previous;
    });
    state.notifyFilter = stillValid ? previous : '';
    notifyTopicFilter.value = state.notifyFilter;
  }

  function renderNotifyRows() {
    notifyRows.replaceChildren();
    /* fetchKey 不匹配时旧缓存不可见，避免切频道闪「该频道无通知」。 */
    var keyMatches = state.notifyFetchKey === notifyFetchKey();
    var rows = keyMatches ? filteredNotifyMessages() : [];
    var total = rows.length;
    var truncated = total > NOTIFY_RENDER_LIMIT;
    var visible = truncated ? rows.slice(0, NOTIFY_RENDER_LIMIT) : rows;
    /* 只要 fetchKey 对不上，就当加载中——含 enterNotifications 首帧尚未 pending 的窗口。 */
    var awaiting = state.notifyStatus === 'loading' || !keyMatches;
    notifyShown.textContent = awaiting
      ? ''
      : truncated
        ? 'Showing latest ' + NOTIFY_RENDER_LIMIT + ' of ' + total
        : String(total);
    if (awaiting) {
      notifyStateNode.textContent = 'Loading…';
      return;
    }
    if (state.notifyStatus === 'error' && state.notifyMessages.length === 0) {
      notifyStateNode.textContent = state.notifyMessage || 'Notifications could not be loaded. Try Refresh.';
      return;
    }
    if (rows.length === 0) {
      notifyStateNode.textContent = state.notifyFilter
        ? 'No notifications on this channel in the last 12 hours.'
        : 'No notifications in the last 12 hours. Refresh after a push is sent.';
      return;
    }
    notifyStateNode.textContent = truncated
      ? 'Showing latest ' + NOTIFY_RENDER_LIMIT + ' of ' + total + ' notifications.'
      : '';
    visible.forEach(function (row) {
      var tier = tierFromPriority(row.priority);
      var item = document.createElement('article');
      item.className = 'notify-row';

      var whenCell = document.createElement('div');
      whenCell.className = 'cell notify-when';
      var whenLabel = document.createElement('span');
      whenLabel.className = 'cell-label';
      whenLabel.textContent = 'When';
      var whenValue = document.createElement('time');
      whenValue.dateTime = row.time ? new Date(row.time * 1000).toISOString() : '';
      whenValue.textContent = row.time
        ? formatDate(new Date(row.time * 1000).toISOString())
        : '—';
      whenCell.append(whenLabel, whenValue);

      var channelCell = document.createElement('div');
      channelCell.className = 'cell notify-channel';
      var channelLabel = document.createElement('span');
      channelLabel.className = 'cell-label';
      channelLabel.textContent = 'Channel';
      var channelValue = document.createElement('span');
      channelValue.textContent = formatNotifyChannel(row.topic);
      channelCell.append(channelLabel, channelValue);

      var tierCell = document.createElement('div');
      tierCell.className = 'cell';
      var tierLabel = document.createElement('span');
      tierLabel.className = 'cell-label';
      tierLabel.textContent = 'Tier';
      var tierValue = document.createElement('span');
      tierValue.className = 'notify-tier';
      tierValue.setAttribute('data-tier', tier);
      tierValue.textContent = tier;
      tierCell.append(tierLabel, tierValue);

      var contentCell = document.createElement('div');
      contentCell.className = 'cell notify-content';
      var contentLabel = document.createElement('span');
      contentLabel.className = 'cell-label';
      contentLabel.textContent = 'Content';
      var title = document.createElement('p');
      title.className = 'notify-title-text';
      title.textContent = row.title || '(no title)';
      var body = document.createElement('p');
      body.className = 'notify-body-text';
      body.textContent = row.message || '';
      contentCell.append(contentLabel, title, body);

      item.append(whenCell, channelCell, tierCell, contentCell);
      notifyRows.append(item);
    });
  }

  function renderNotifyMeta() {
    if (state.notifyUpdatedAt) {
      notifyUpdated.textContent = 'Updated ' + formatClock(new Date(state.notifyUpdatedAt).toISOString(), true);
    } else {
      notifyUpdated.textContent = '';
    }
    notifyNotice.hidden = !state.notifyMessage || state.notifyStatus !== 'error' || state.notifyMessages.length === 0;
    notifyNotice.textContent = notifyNotice.hidden ? '' : state.notifyMessage;
    notifyRefresh.disabled = state.notifyPending;
    notifyRefresh.textContent = state.notifyPending ? 'Refreshing…' : 'Refresh';
  }

  function renderNotify() {
    populateNotifyTopicFilter();
    renderNotifyMeta();
    renderNotifyRows();
  }

  /* 有限并发拉取各 topic，避免 admin 身份很多时 Refresh 串行卡死。 */
  async function mapPool(items, concurrency, worker) {
    var results = new Array(items.length);
    var cursor = 0;
    async function run() {
      while (cursor < items.length) {
        var index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }
    var runners = [];
    var width = Math.max(1, Math.min(concurrency, items.length || 1));
    for (var i = 0; i < width; i++) runners.push(run());
    await Promise.all(runners);
    return results;
  }

  async function fetchNotifyTopic(topic, signal) {
    if (signal.aborted) {
      return { ok: true, skipped: true, topic: topic, messages: [] };
    }
    try {
      var payload = await apiJson(
        '/ui/api/notify/messages?topic=' + encodeURIComponent(topic) + '&since=12h',
        { signal: signal }
      );
      return {
        ok: true,
        topic: topic,
        messages: Array.isArray(payload.messages) ? payload.messages : []
      };
    } catch (error) {
      if (error.message === 'session_expired') throw error;
      /* 扇出短路 abort：当作跳过，不计入失败。 */
      if (error.name === 'AbortError') {
        return { ok: true, skipped: true, topic: topic, messages: [] };
      }
      /* unknown_agent / 未开通频道 → 空列表，不报「加载失败」（诚实空态）。 */
      if (error.status === 404) {
        return { ok: true, topic: topic, messages: [] };
      }
      /* ntfy 未启用/未配置：标记 disabled，由上层短路剩余 topic。 */
      if (error.status === 503) {
        var code = error.body && error.body.error;
        return {
          ok: false,
          disabled: true,
          disabledCode: typeof code === 'string' ? code : '',
          topic: topic,
          messages: []
        };
      }
      return { ok: false, topic: topic, messages: [] };
    }
  }

  async function loadNotifyHistory() {
    cancelNotifyLoad();
    var controller = new AbortController();
    notifyController = controller;
    state.notifyPending = true;
    state.notifyMessage = '';
    /* F4：filter 一变 fetchKey 就变——立刻 loading，别等网络返回才撤掉假空态。 */
    if (state.notifyFetchKey !== notifyFetchKey()) {
      state.notifyMessages = [];
      state.notifyStatus = 'loading';
    } else if (state.notifyMessages.length === 0) {
      state.notifyStatus = 'loading';
    }
    renderNotify();

    var merged = [];
    var failures = 0;
    /* 503 全局短路文案；一旦置位则不再发起新的 topic 请求。 */
    var disabledMessage = '';
    try {
      /* admin 若尚未跑过 Overview，先补 identities，才能派生 agent:* topic。 */
      if (isAdmin() && state.identities.length === 0) {
        var identityPayload = await apiJson('/ui/api/identities', { signal: controller.signal });
        if (controller.signal.aborted || notifyController !== controller) return;
        state.identities = Array.isArray(identityPayload.identities)
          ? identityPayload.identities
          : [];
        renderIdentities();
        /* identities 到位后 topic 集合可能变宽，再次对齐 loading。 */
        if (state.notifyFetchKey !== notifyFetchKey()) {
          state.notifyMessages = [];
          state.notifyStatus = 'loading';
          renderNotify();
        }
      }
      /* 选了具体频道时只拉一路；All 才扇出，并用有限并发。 */
      var topics = notifyTopicsToFetch();
      var fetchKey = topics.join('|');

      var batches = await mapPool(topics, 6, function (topic) {
        if (disabledMessage) {
          return Promise.resolve({
            ok: true,
            skipped: true,
            topic: topic,
            messages: []
          });
        }
        return fetchNotifyTopic(topic, controller.signal).then(function (result) {
          if (result && result.disabled && !disabledMessage) {
            disabledMessage = result.disabledCode === 'notifications_disabled'
              ? 'Notifications are disabled on this server.'
              : 'Notifications are not configured on this server.';
            try {
              controller.abort();
            } catch (_abortError) {
              /* ignore */
            }
          }
          return result;
        });
      });
      if (notifyController !== controller) return;
      if (disabledMessage) {
        state.notifyMessages = [];
        state.notifyUpdatedAt = Date.now();
        state.notifyFetchKey = fetchKey;
        state.notifyStatus = 'error';
        state.notifyMessage = disabledMessage;
        renderNotify();
        announce(disabledMessage);
        return;
      }
      batches.forEach(function (batch) {
        if (!batch || batch.skipped) return;
        if (!batch.ok) {
          failures += 1;
          return;
        }
        /* identity 的 self 在 UI 上标成 agent:<localpart>，不暴露 self 别名。 */
        var displayTopic = batch.topic === 'self' && state.me && state.me.address
          ? 'agent:' + state.me.address.split('@')[0]
          : batch.topic;
        batch.messages.forEach(function (message) {
          merged.push({
            id: message.id,
            time: typeof message.time === 'number' ? message.time : 0,
            title: message.title || '',
            message: message.message || '',
            priority: typeof message.priority === 'number' ? message.priority : 0,
            tags: Array.isArray(message.tags) ? message.tags : [],
            topic: displayTopic
          });
        });
      });
      merged.sort(function (left, right) {
        return (right.time || 0) - (left.time || 0);
      });
      /* F8：同频道全败刷新保留旧缓存；外层 catch 走不到这条路（每路已折成 ok:false）。 */
      if (
        failures &&
        merged.length === 0 &&
        state.notifyMessages.length > 0 &&
        state.notifyFetchKey === fetchKey
      ) {
        state.notifyStatus = 'error';
        state.notifyMessage = 'Refresh failed. Showing previous notifications.';
        renderNotify();
        announce(state.notifyMessage);
      } else {
        state.notifyMessages = merged;
        state.notifyUpdatedAt = Date.now();
        state.notifyFetchKey = fetchKey;
        if (failures && merged.length === 0) {
          state.notifyStatus = 'error';
          state.notifyMessage = 'Notifications could not be loaded. Try Refresh.';
        } else if (failures) {
          state.notifyStatus = 'error';
          state.notifyMessage = 'Some channels could not be loaded. Showing what succeeded.';
        } else {
          state.notifyStatus = 'ready';
          state.notifyMessage = '';
        }
        renderNotify();
        announce(merged.length + ' notifications loaded');
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.notifyMessages.length === 0) {
        state.notifyStatus = 'error';
        state.notifyMessage = 'Notifications could not be loaded. Try Refresh.';
        /* 对齐 fetchKey，避免 !keyMatches 把诚实错误盖成永远 Loading… */
        state.notifyFetchKey = notifyFetchKey();
      } else {
        state.notifyStatus = 'error';
        state.notifyMessage = 'Refresh failed. Showing previous notifications.';
      }
      renderNotify();
    } finally {
      if (notifyController === controller) {
        notifyController = null;
        state.notifyPending = false;
        renderNotifyMeta();
      }
    }
  }

  function enterNotifications(options) {
    var opts = options || {};
    cancelOverview();
    cancelTasksLoad();
    applyScope('notifications', { announce: opts.announce });
    renderNotify();
    focusNotifyPanel();
    /* 15s 内有成功缓存且 topic 集合未变则只重绘，避免 All 误用单路缓存。 */
    var age = state.notifyUpdatedAt ? Math.max(0, Date.now() - state.notifyUpdatedAt) : Infinity;
    if (
      state.notifyStatus === 'ready' &&
      age < FRESH_MS &&
      state.notifyFetchKey === notifyFetchKey()
    ) return;
    loadNotifyHistory();
  }

  /* ---- 任务工单面板（与 Notifications 并列；列表走 /ui/api/tasks，详情走 /:id） ---- */
  function focusTasksPanel() {
    tasksPanel.focus({ preventScroll: true });
  }

  function cancelTasksListLoad() {
    if (tasksController) {
      tasksController.abort();
      tasksController = null;
    }
    state.tasksPending = false;
  }

  function cancelTaskDetailLoad() {
    if (taskDetailController) {
      taskDetailController.abort();
      taskDetailController = null;
    }
    /* 离开 scope / 换单时 abort：勿把 loading 粘住，否则 FRESH_MS 内重进会假刷新。 */
    if (state.taskDetailStatus === 'loading') {
      state.taskDetailStatus = state.taskDetail ? 'ready' : 'idle';
    }
  }

  function cancelTasksLoad() {
    cancelTasksListLoad();
    cancelTaskDetailLoad();
  }

  function clearTaskDetail() {
    cancelTaskDetailLoad();
    state.activeTaskId = '';
    state.taskDetail = null;
    state.taskDetailStatus = 'idle';
    state.taskDetailMessage = '';
    tasksDetailContent.replaceChildren();
    var placeholder = document.createElement('div');
    placeholder.className = 'detail-placeholder';
    var label = document.createElement('p');
    label.className = 'eyebrow';
    label.textContent = 'Task ticket';
    var title = document.createElement('h2');
    title.textContent = 'Select a task';
    var copy = document.createElement('p');
    copy.className = 'muted';
    copy.textContent = 'Choose a ticket to inspect its state timeline and result.';
    placeholder.append(label, title, copy);
    tasksDetailContent.append(placeholder);
  }

  function renderTasksMeta() {
    if (state.tasksUpdatedAt) {
      tasksUpdated.textContent = 'Updated ' + formatClock(new Date(state.tasksUpdatedAt).toISOString(), true);
    } else {
      tasksUpdated.textContent = '';
    }
    /* 详情错误优先；列表刷新失败且仍有缓存时也用 notice（空列表错误走 empty-state）。 */
    if (state.taskDetailStatus === 'error' && state.taskDetailMessage) {
      tasksNotice.hidden = false;
      tasksNotice.textContent = state.taskDetailMessage;
    } else if (state.tasksStatus === 'error' && state.tasksMessage && state.tasks.length > 0) {
      tasksNotice.hidden = false;
      tasksNotice.textContent = state.tasksMessage;
    } else {
      tasksNotice.hidden = true;
      tasksNotice.textContent = '';
    }
    tasksRefresh.disabled = state.tasksPending;
    tasksRefresh.textContent = state.tasksPending ? 'Refreshing…' : 'Refresh';
    tasksStateFilter.value = state.tasksFilter;
  }

  function renderTaskRows() {
    tasksRows.replaceChildren();
    var awaiting = state.tasksStatus === 'loading';
    tasksShown.textContent = awaiting ? '' : String(state.tasks.length);
    if (awaiting) {
      tasksStateNode.textContent = 'Loading…';
      return;
    }
    if (state.tasksStatus === 'error' && state.tasks.length === 0) {
      tasksStateNode.textContent = state.tasksMessage || 'Tasks could not be loaded. Try Refresh.';
      return;
    }
    if (state.tasks.length === 0) {
      tasksStateNode.textContent = state.tasksFilter
        ? 'No tasks in state "' + state.tasksFilter + '".'
        : 'No tasks yet. Refresh after a task mail arrives.';
      return;
    }
    tasksStateNode.textContent = '';
    state.tasks.forEach(function (task) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-row';
      button.setAttribute('aria-current', task.id === state.activeTaskId ? 'true' : 'false');

      var stateCell = document.createElement('div');
      stateCell.className = 'cell';
      var stateLabel = document.createElement('span');
      stateLabel.className = 'cell-label';
      stateLabel.textContent = 'State';
      var badge = document.createElement('span');
      badge.className = 'task-badge';
      badge.setAttribute('data-state', task.state || '');
      badge.textContent = task.state || '—';
      stateCell.append(stateLabel, badge);

      var peopleCell = document.createElement('div');
      peopleCell.className = 'cell task-participants';
      var peopleLabel = document.createElement('span');
      peopleLabel.className = 'cell-label';
      peopleLabel.textContent = 'Participants';
      var peopleValue = document.createElement('span');
      peopleValue.textContent = (task.from || '—') + ' → ' + (task.to || '—');
      peopleCell.append(peopleLabel, peopleValue);

      var subjectCell = document.createElement('div');
      subjectCell.className = 'cell';
      var subjectLabel = document.createElement('span');
      subjectLabel.className = 'cell-label';
      subjectLabel.textContent = 'Subject';
      var subjectValue = document.createElement('p');
      subjectValue.className = 'task-subject';
      subjectValue.textContent = task.subject || '(no subject)';
      subjectCell.append(subjectLabel, subjectValue);

      var updatedCell = document.createElement('div');
      updatedCell.className = 'cell task-updated';
      var updatedLabel = document.createElement('span');
      updatedLabel.className = 'cell-label';
      updatedLabel.textContent = 'Updated';
      var updatedValue = document.createElement('time');
      updatedValue.dateTime = task.updatedAt || '';
      updatedValue.textContent = formatAgo(task.updatedAt);
      updatedCell.append(updatedLabel, updatedValue);

      var msgsCell = document.createElement('div');
      msgsCell.className = 'cell task-msgs';
      var msgsLabel = document.createElement('span');
      msgsLabel.className = 'cell-label';
      msgsLabel.textContent = 'Msgs';
      var msgsValue = document.createElement('span');
      msgsValue.textContent = String(Array.isArray(task.messages) ? task.messages.length : 0);
      msgsCell.append(msgsLabel, msgsValue);

      button.append(stateCell, peopleCell, subjectCell, updatedCell, msgsCell);
      button.addEventListener('click', function () {
        selectTask(task.id);
      });
      tasksRows.append(button);
    });
  }

  function renderTaskDetail() {
    if (!state.activeTaskId) {
      clearTaskDetail();
      return;
    }
    /* 错误态绝不回落成「成功详情」：列表缓存也不能冒充 GET /:id 成功。 */
    if (state.taskDetailStatus === 'error') {
      tasksDetailContent.replaceChildren();
      var err = document.createElement('p');
      err.className = 'empty-state';
      err.textContent = state.taskDetailMessage || 'Task could not be loaded.';
      tasksDetailContent.append(err);
      return;
    }
    if (state.taskDetailStatus === 'loading' && !state.taskDetail) {
      tasksDetailContent.replaceChildren();
      var loading = document.createElement('p');
      loading.className = 'empty-state';
      loading.textContent = 'Loading task…';
      tasksDetailContent.append(loading);
      return;
    }
    var task = state.taskDetail;
    if (!task) {
      clearTaskDetail();
      return;
    }
    tasksDetailContent.replaceChildren();

    var head = document.createElement('div');
    head.className = 'task-detail-head';
    var badge = document.createElement('span');
    badge.className = 'task-badge';
    badge.setAttribute('data-state', task.state || '');
    badge.textContent = task.state || '—';
    var title = document.createElement('h3');
    title.textContent = task.subject || '(no subject)';
    var meta = document.createElement('p');
    meta.className = 'task-detail-meta';
    meta.textContent =
      (task.from || '—') +
      ' → ' +
      (task.to || '—') +
      ' · updated ' +
      formatAgo(task.updatedAt) +
      ' · ' +
      (Array.isArray(task.messages) ? task.messages.length : 0) +
      ' messages';
    head.append(badge, title, meta);
    if (state.taskDetailStatus === 'loading') {
      var pending = document.createElement('p');
      pending.className = 'task-detail-meta';
      pending.textContent = 'Refreshing ticket detail…';
      head.append(pending);
    }
    tasksDetailContent.append(head);

    var timeline = document.createElement('ol');
    timeline.className = 'task-timeline';
    (Array.isArray(task.messages) ? task.messages : []).forEach(function (message) {
      var item = document.createElement('li');
      item.className = 'task-timeline-item';
      var metaRow = document.createElement('div');
      metaRow.className = 'task-timeline-meta';
      var msgBadge = document.createElement('span');
      msgBadge.className = 'task-badge';
      msgBadge.setAttribute('data-state', message.state || '');
      msgBadge.textContent = message.state || '—';
      var from = document.createElement('span');
      from.className = 'task-timeline-from';
      from.textContent = message.from || '—';
      var when = document.createElement('time');
      when.className = 'task-timeline-time';
      when.dateTime = message.date || '';
      when.textContent = message.date ? formatDate(message.date) : '—';
      metaRow.append(msgBadge, from, when);
      var body = document.createElement('p');
      body.className = 'task-timeline-body';
      body.textContent = message.body || '';
      item.append(metaRow, body);
      timeline.append(item);
    });
    tasksDetailContent.append(timeline);

    if (task.result !== undefined) {
      var resultBlock = document.createElement('details');
      resultBlock.className = 'task-result';
      resultBlock.open = true;
      var summary = document.createElement('summary');
      summary.textContent = 'Result';
      var pre = document.createElement('pre');
      try {
        pre.textContent = JSON.stringify(task.result, null, 2);
      } catch (_error) {
        pre.textContent = String(task.result);
      }
      resultBlock.append(summary, pre);
      tasksDetailContent.append(resultBlock);
    }
  }

  function renderTasks() {
    renderTasksMeta();
    renderTaskRows();
    renderTaskDetail();
  }

  async function loadTasks() {
    /* 刷新列表不打断详情请求，避免 activeTask 卡在 loading。 */
    cancelTasksListLoad();
    var controller = new AbortController();
    tasksController = controller;
    state.tasksPending = true;
    state.tasksMessage = '';
    if (state.tasks.length === 0) state.tasksStatus = 'loading';
    renderTasks();
    try {
      var path = '/ui/api/tasks';
      if (state.tasksFilter) {
        path += '?state=' + encodeURIComponent(state.tasksFilter);
      }
      var payload = await apiJson(path, { signal: controller.signal });
      if (tasksController !== controller) return;
      state.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      state.tasksUpdatedAt = Date.now();
      state.tasksStatus = 'ready';
      state.tasksMessage = '';
      renderTasks();
      announce(state.tasks.length + ' tasks loaded');
      if (state.activeTaskId) {
        var stillThere = state.tasks.some(function (task) {
          return task.id === state.activeTaskId;
        });
        if (!stillThere) clearTaskDetail();
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.tasks.length === 0) {
        state.tasksStatus = 'error';
        state.tasksMessage = 'Tasks could not be loaded. Try Refresh.';
      } else {
        state.tasksStatus = 'error';
        state.tasksMessage = 'Refresh failed. Showing previous tasks.';
      }
      renderTasks();
    } finally {
      if (tasksController === controller) {
        tasksController = null;
        state.tasksPending = false;
        renderTasksMeta();
      }
    }
  }

  async function selectTask(id) {
    if (!id) return;
    cancelTaskDetailLoad();
    state.activeTaskId = id;
    state.taskDetailStatus = 'loading';
    state.taskDetailMessage = '';
    /* 列表摘要可先展示，但失败时必须清空，不能冒充详情成功。 */
    var cached = state.tasks.find(function (task) {
      return task.id === id;
    });
    state.taskDetail = cached || null;
    inboxView.dataset.mobileView = 'tasks-detail';
    renderTasks();
    tasksDetailSection.focus({ preventScroll: true });
    var controller = new AbortController();
    taskDetailController = controller;
    try {
      var detail = await apiJson('/ui/api/tasks/' + encodeURIComponent(id), {
        signal: controller.signal
      });
      if (taskDetailController !== controller || state.activeTaskId !== id) return;
      state.taskDetail = detail;
      state.taskDetailStatus = 'ready';
      state.taskDetailMessage = '';
      renderTasks();
      announce('Opened task ' + (detail.subject || id));
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.activeTaskId !== id) return;
      state.taskDetail = null;
      state.taskDetailStatus = 'error';
      state.taskDetailMessage =
        error.status === 403
          ? 'You are not a participant on this task.'
          : error.status === 404
            ? 'Task not found.'
            : 'Task could not be loaded.';
      renderTasks();
      announce(state.taskDetailMessage);
    } finally {
      if (taskDetailController === controller) taskDetailController = null;
    }
  }

  function enterTasks(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    applyScope('tasks', { announce: opts.announce });
    renderTasks();
    focusTasksPanel();
    var age = state.tasksUpdatedAt ? Math.max(0, Date.now() - state.tasksUpdatedAt) : Infinity;
    if (state.tasksStatus === 'ready' && age < FRESH_MS) return;
    loadTasks();
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

  async function copyValue(value, sourceNode, sourceButton) {
    try {
      await navigator.clipboard.writeText(value);
      announce('Copied to clipboard');
      /* 颜色不是唯一信号：播报先行，绿色只是附加确认。 */
      if (sourceButton) {
        sourceButton.classList.add('copied');
        window.setTimeout(function () {
          sourceButton.classList.remove('copied');
        }, 1200);
      }
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
      copyValue(parsed.href, url, copy);
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
          copyValue(code, value, copy);
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

    var summary = null;
    for (var mi = 0; mi < state.messages.length; mi++) {
      if (state.messages[mi].id === detail.id) { summary = state.messages[mi]; break; }
    }
    if (summary) {
      var seenToggle = document.createElement('button');
      seenToggle.type = 'button';
      seenToggle.className = 'quiet seen-toggle';
      seenToggle.textContent = summary.seen ? 'Mark as unread' : 'Mark as read';
      seenToggle.addEventListener('click', function () {
        toggleSeen(detail.id, summary, seenToggle);
      });
      header.append(seenToggle);
    }

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

  async function toggleSeen(id, summary, button) {
    button.disabled = true;
    try {
      await apiJson('/ui/api/messages/' + encodeURIComponent(id) + '/seen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: state.activeAddress, seen: !summary.seen })
      });
      summary.seen = !summary.seen;
      button.textContent = summary.seen ? 'Mark as unread' : 'Mark as read';
      renderMessages();
      announce(summary.seen ? 'Marked as read.' : 'Marked as unread.');
    } catch (error) {
      if (error.message !== 'session_expired') {
        announce('Could not update the message. Try again.');
      }
    } finally {
      button.disabled = false;
    }
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
      detailPanel.focus();
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

  async function startSession() {
    configureSession();
    byId('session-label').textContent = state.me.kind === 'admin'
      ? 'Admin session'
      : state.me.address;
    if (isAdmin()) {
      /* admin 落地 Overview：首屏零 IMAP，不碰 /ui/api/messages。 */
      applyScope('overview');
      renderOverview();
      focusOverviewPanel();
      loadOverviewCycle({ refresh: false });
      return;
    }
    applyScope('inbox');
    await loadInbox();
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
        body: JSON.stringify({ token: credential, remember: loginRemember.checked })
      });
      if (!response.ok) {
        loginError.textContent = response.status === 401
          ? 'That token is not valid.'
          : 'Sign-in is temporarily unavailable. Try again.';
        return;
      }
      state.me = await response.json();
      showInbox();
      await startSession();
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
      state.overview = null;
      state.overviewStatus = 'idle';
      /* showLogin → clearNotifyState：与 401 过期路径同一套清理。 */
      showLogin('');
    }
  });

  identitySearch.addEventListener('input', function () {
    state.identityFilter = identitySearch.value;
    renderIdentities();
  });
  overviewSearch.addEventListener('input', function () {
    state.overviewFilter = overviewSearch.value;
    renderOverview();
    announce(sortedModels().length + ' addresses match your filter.');
  });
  mobileIdentity.addEventListener('change', function () {
    if (mobileIdentity.value === '') {
      enterOverview({ announce: 'Back to overview' });
      return;
    }
    if (mobileIdentity.value === '__notifications__') {
      enterNotifications({ announce: 'Opened notifications' });
      return;
    }
    if (mobileIdentity.value === '__tasks__') {
      enterTasks({ announce: 'Opened tasks' });
      return;
    }
    activateAddress(mobileIdentity.value);
  });
  refreshButton.addEventListener('click', function () {
    /* identity 会话只有一个地址、也没有 Overview 可回，所以只有 admin 需要这一步。 */
    if (isAdmin()) refreshInboxIdentities();
    refreshMessages();
  });
  overviewRefresh.addEventListener('click', function () {
    state.overviewPolls = 0;
    state.overviewLoadingSince = 0;
    loadOverviewCycle({ refresh: true });
  });
  notifyRefresh.addEventListener('click', function () {
    loadNotifyHistory();
  });
  notifyTopicFilter.addEventListener('change', function () {
    state.notifyFilter = notifyTopicFilter.value;
    /* 过滤切换会改变要请求的 topic 集合（All 扇出 vs 单路），重新拉取。 */
    loadNotifyHistory();
  });
  tasksRefresh.addEventListener('click', function () {
    loadTasks();
  });
  tasksStateFilter.addEventListener('change', function () {
    state.tasksFilter = tasksStateFilter.value;
    clearTaskDetail();
    loadTasks();
  });
  tasksMobileBack.addEventListener('click', function () {
    inboxView.dataset.mobileView = 'tasks-list';
    var active = tasksRows.querySelector('[aria-current="true"]');
    if (active) active.focus();
    else focusTasksPanel();
  });
  createIdentityButton.addEventListener('click', showCreateModal);
  createModalSubmit.addEventListener('click', handleCreateSubmit);
  tokenCopyButton.addEventListener('click', function () {
    copyValue(tokenValue.textContent, tokenValue, tokenCopyButton);
  });
  tokenModalClose.addEventListener('click', closeAllModals);
  confirmModalCancel.addEventListener('click', function () {
    // closeAllModals consumes the pending cancel side-effect exactly once (F107).
    closeAllModals();
  });
  createModalCancel.addEventListener('click', closeAllModals);
  backToOverview.addEventListener('click', function () {
    enterOverview({ returnTo: state.returnAddress, announce: 'Back to overview' });
  });
  byId('mobile-back').addEventListener('click', function () {
    inboxView.dataset.mobileView = 'list';
    var active = messageList.querySelector('[aria-current="true"]');
    if (active) active.focus();
  });

  buildSortControls();

  (async function start() {
    configureLoginGate();
    try {
      var response = await fetch('/ui/api/me', { credentials: 'same-origin' });
      if (response.status === 401) { showLogin(''); return; }
      if (!response.ok) throw new Error('request_failed');
      state.me = await response.json();
      showInbox();
      await startSession();
    } catch {
      showLogin('Could not reach the server.');
    }
  })();
})();`;
