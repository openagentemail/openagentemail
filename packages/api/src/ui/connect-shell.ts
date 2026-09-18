const CONNECT_NAV =
  '            <li><a class="app-nav-link" data-nav="connect" href="/ui/connect">Connect an agent</a></li>\n';

const CONNECT_PANEL = `      <main id="connect-panel" class="configure-panel connect-panel" tabindex="-1" aria-labelledby="connect-title" hidden>
        <div class="panel-heading overview-heading">
          <div>
            <h2 id="connect-title">Connect an agent</h2>
            <p class="overview-subtitle">Give a coding agent secure access to this identity through the instance MCP endpoint.</p>
          </div>
        </div>
        <section id="connect-credential" class="connect-credential" aria-labelledby="connect-credential-title" hidden>
          <h3 id="connect-credential-title">Connection details</h3>
          <dl class="connect-details">
            <div><dt>Identity</dt><dd id="connect-identity"></dd></div>
            <div><dt>MCP endpoint</dt><dd><code id="connect-endpoint"></code></dd></div>
            <div><dt>Identity token</dt><dd class="connect-token-row"><code id="connect-token">••••••••••••</code><button id="connect-token-reveal" class="quiet" type="button" aria-pressed="false">Reveal</button><button id="connect-token-copy" class="quiet" type="button">Copy token</button></dd></div>
          </dl>
          <p class="fine-print">Treat this token like a password. Do not paste it into chat, commit it, or share screenshots containing it.</p>
        </section>
        <p id="connect-state" class="empty-state">Loading connection details…</p>
        <div id="connect-cards" class="connect-cards"></div>
      </main>

`;

/** Add the Connect page to the generated dashboard shell at stable landmarks. */
export function withConnectShell(shell: string): string {
  const navLandmark =
    '            <li><a class="app-nav-link" data-nav="configure-clients" href="/ui/configure/clients">Connected apps</a></li>\n';
  const panelLandmark =
    '      <main id="configure-identities-panel" class="configure-panel" tabindex="-1" aria-labelledby="configure-identities-title" hidden>\n';
  if (!shell.includes(navLandmark) || !shell.includes(panelLandmark)) {
    throw new Error('connect_shell_landmark_missing');
  }
  return shell
    .replace(navLandmark, navLandmark + CONNECT_NAV)
    .replace(panelLandmark, CONNECT_PANEL + panelLandmark);
}
