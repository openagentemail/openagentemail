var connectCredentialValue = '';
var connectEndpointValue = '';
var connectRevealed = false;

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function jsonConfig(server) {
  return JSON.stringify({ mcpServers: { 'openagent-email': server } }, null, 2);
}

function connectAgentDefinitions(endpoint, token) {
  var authorization = 'Bearer ' + token;
  var jsonServer = { url: endpoint, headers: { Authorization: authorization } };
  return [
    {
      name: 'Kimi Code',
      location: '~/.kimi-code/mcp.json',
      config: jsonConfig(jsonServer),
      prompt:
        'Add an HTTP MCP server named openagent-email to ~/.kimi-code/mcp.json using this exact configuration. Do not print or commit the token. Then start a new Kimi Code session and verify the server with /mcp.',
    },
    {
      name: 'Codex',
      location: '~/.codex/config.toml',
      config:
        '[mcp_servers.openagent_email]\nurl = ' +
        JSON.stringify(endpoint) +
        '\nhttp_headers = { Authorization = ' +
        JSON.stringify(authorization) +
        ' }',
      prompt:
        'Add the following openagent_email Streamable HTTP MCP server to ~/.codex/config.toml. Preserve my existing settings, never print or commit the token, and verify it with codex mcp get openagent_email.',
    },
    {
      name: 'Claude Code',
      location: 'Terminal command',
      config:
        'claude mcp add --transport http --scope user --header ' +
        shellSingleQuote('Authorization: ' + authorization) +
        ' openagent-email ' +
        shellSingleQuote(endpoint),
      prompt:
        'Run the following command to add my OpenAgent.email server to Claude Code at user scope. Do not echo, log, or commit the token. Then run claude mcp get openagent-email to verify it.',
    },
    {
      name: 'Cursor',
      location: '~/.cursor/mcp.json',
      config: jsonConfig(jsonServer),
      prompt:
        'Merge this server into ~/.cursor/mcp.json without removing existing servers. Keep the bearer token private, then open Cursor MCP settings and confirm openagent-email connects.',
    },
    {
      name: 'ZCode',
      location: '~/.zcode/cli/config.json',
      config: JSON.stringify(
        {
          mcp: {
            servers: {
              'openagent-email': {
                type: 'http',
                url: endpoint,
                headers: { Authorization: authorization },
              },
            },
          },
        },
        null,
        2,
      ),
      prompt:
        'Merge this HTTP server into mcp.servers in ~/.zcode/cli/config.json without changing my other settings. Keep the token private, restart the agent session, and verify openagent-email in Settings > MCP Servers.',
    },
    {
      name: 'ChatGPT',
      manual: true,
      config:
        'OAuth connector setup is coming in a separate update. Do not paste an identity token into a ChatGPT conversation.',
      prompt:
        'Open ChatGPT Settings > Connectors and look for a custom MCP connector option. If it is unavailable, stop; do not paste this identity token into chat.',
    },
    {
      name: 'Grok',
      manual: true,
      config:
        'OAuth connector setup is coming in a separate update. Do not paste an identity token into a Grok conversation.',
      prompt:
        'Open Grok settings and look for an MCP or connector setup flow. If it is unavailable, stop; do not paste this identity token into chat.',
    },
  ];
}

function redactConnectText(value) {
  if (!connectCredentialValue || connectRevealed) return value;
  return value.split(connectCredentialValue).join('<identity-token>');
}

function connectCopyButton(label, value, sourceNode, sensitive) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet';
  button.textContent = label;
  button.disabled = Boolean(sensitive && !connectRevealed);
  if (button.disabled)
    button.title = 'Reveal the identity token before copying this value.';
  button.addEventListener('click', function () {
    copyValue(value, sourceNode, button);
  });
  return button;
}

function renderConnectCards() {
  connectCards.replaceChildren();
  if (!connectEndpointValue) return;
  var definitions = connectAgentDefinitions(
    connectEndpointValue,
    connectCredentialValue,
  );
  definitions.forEach(function (definition) {
    var card = document.createElement('article');
    card.className = 'connect-card';
    if (definition.manual) card.dataset.manual = 'true';
    var title = document.createElement('h3');
    title.textContent = definition.name;
    var location = document.createElement('p');
    location.className = 'connect-card-location';
    location.textContent = definition.manual
      ? 'Manual connection'
      : definition.location;
    var config = document.createElement('pre');
    config.className = 'connect-config';
    var configCode = document.createElement('code');
    configCode.textContent = redactConnectText(definition.config);
    config.append(configCode);
    var configCopy = connectCopyButton(
      'Copy setup',
      definition.config,
      configCode,
      !definition.manual,
    );
    var promptLabel = document.createElement('h4');
    promptLabel.textContent = 'Paste to your agent';
    var prompt = document.createElement('p');
    prompt.className = 'connect-prompt';
    prompt.textContent = definition.prompt;
    var promptCopy = connectCopyButton(
      'Copy instruction',
      definition.prompt + '\n\n' + definition.config,
      prompt,
      !definition.manual,
    );
    var actions = document.createElement('div');
    actions.className = 'connect-card-actions';
    actions.append(configCopy, promptCopy);
    card.append(title, location, config, actions, promptLabel, prompt);
    connectCards.append(card);
  });
}

function clearConnectSensitiveState() {
  connectCredentialValue = '';
  connectEndpointValue = '';
  connectRevealed = false;
  connectToken.textContent = '••••••••••••';
  connectTokenReveal.textContent = 'Reveal';
  connectTokenReveal.setAttribute('aria-pressed', 'false');
  connectTokenCopy.disabled = true;
  connectEndpoint.textContent = '';
  connectIdentity.textContent = '';
  connectCredential.hidden = true;
  connectCards.replaceChildren();
}

async function loadConnectPage() {
  clearConnectSensitiveState();
  connectState.textContent = 'Loading connection details…';
  try {
    var payload = await apiJson('/ui/api/connect');
    if (state.scope !== 'connect') return;
    connectEndpointValue = payload.endpoint || '';
    connectEndpoint.textContent = connectEndpointValue;
    if (payload.unavailable === 'identity_session_required') {
      connectState.textContent =
        'Sign in with an identity token to build agent-specific setup instructions. Admin credentials are never exposed here.';
      return;
    }
    connectIdentity.textContent = payload.identity || '';
    if (payload.unavailable === 'token_unavailable' || !payload.token) {
      connectState.textContent =
        'This session was restored without a plaintext token. Sign out and sign in directly with this identity token to reveal setup instructions.';
      return;
    }
    connectCredentialValue = payload.token;
    connectCredential.hidden = false;
    connectTokenCopy.disabled = false;
    connectState.textContent =
      'Reveal the token to enable ready-to-copy setup for each agent.';
    renderConnectCards();
  } catch (error) {
    if (error.message !== 'session_expired') {
      connectState.textContent =
        'Connection details could not be loaded. Try opening this page again.';
    }
  }
}

function enterConnect(options) {
  var opts = options || {};
  cancelOverview();
  cancelNotifyLoad();
  cancelTasksLoad();
  applyScope('connect', { announce: opts.announce });
  connectPanel.focus({ preventScroll: true });
  loadConnectPage();
}

connectTokenReveal.addEventListener('click', function () {
  if (!connectCredentialValue) return;
  connectRevealed = !connectRevealed;
  connectToken.textContent = connectRevealed
    ? connectCredentialValue
    : '••••••••••••';
  connectTokenReveal.textContent = connectRevealed ? 'Hide' : 'Reveal';
  connectTokenReveal.setAttribute('aria-pressed', String(connectRevealed));
  renderConnectCards();
  announce(
    connectRevealed ? 'Identity token revealed.' : 'Identity token hidden.',
  );
});

connectTokenCopy.addEventListener('click', function () {
  if (!connectCredentialValue) return;
  copyValue(connectCredentialValue, connectToken, connectTokenCopy);
});
