var connectCredentialValue = '';
var connectEndpointValue = '';
var connectRevealed = false;
/** 代际：clear/logout 自增，迟到的 loadConnectPage 响应不得复活明文。 */
var connectLoadGen = 0;

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
      name: t('connect.copy.kimiCode'),
      location: '~/.kimi-code/mcp.json',
      config: jsonConfig(jsonServer),
      // R5：掐读回——写入后重启/重连即生效；勿读回含 token 文件、勿打印
      // allowlist: agent paste instruction（非 UI 壳层；见 completion.md）
      prompt:
        'I already saved openagent-email into ~/.kimi-code/mcp.json with Copy setup. Do not ask me to paste a token. Do not read that file back or print the bearer. Restart or reconnect the agent so the new MCP entry takes effect.',
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
      // allowlist: agent paste instruction
      prompt:
        'I already added openagent_email to ~/.codex/config.toml with Copy setup. Do not ask me to paste a token. Do not read that config back or print the bearer. Restart or reconnect so the MCP server takes effect.',
    },
    {
      name: t('connect.copy.claudeCode'),
      location: t('connect.copy.terminalCommand'),
      // R6：命令本体零凭证——header 用 $OAE_TOKEN 变量引用（单引号外展开）
      config:
        'claude mcp add --transport http --scope user --header ' +
        "'Authorization: Bearer '" +
        '$OAE_TOKEN' +
        ' openagent-email ' +
        shellSingleQuote(endpoint),
      // allowlist: agent paste instruction
      prompt:
        'In your shell, run read -s OAE_TOKEN and paste the identity token (silent input, not saved to history), then press Enter. Next run the Copy setup command; it references $OAE_TOKEN and never embeds the bearer. Do not echo or print OAE_TOKEN. Restart or reconnect so Claude Code picks up the MCP entry.',
    },
    {
      name: 'Cursor',
      location: '~/.cursor/mcp.json',
      config: jsonConfig(jsonServer),
      // allowlist: agent paste instruction
      prompt:
        'I already merged openagent-email into ~/.cursor/mcp.json with Copy setup. Do not ask me to paste a token. Do not read that file back or print the bearer. Restart or reconnect Cursor MCP so openagent-email takes effect.',
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
      // allowlist: agent paste instruction
      prompt:
        'I already merged openagent-email into mcp.servers in ~/.zcode/cli/config.json with Copy setup. Do not ask me to paste a token. Do not read that config back or print the bearer. Restart or reconnect the agent session so it takes effect.',
    },
    {
      name: 'ChatGPT',
      manual: true,
      // allowlist: connector placeholder paste
      config:
        'OAuth connector setup is coming in a separate update. Do not paste an identity token into a ChatGPT conversation.',
      // allowlist: agent paste instruction
      prompt:
        'Open ChatGPT Settings > Connectors and look for a custom MCP connector option. If it is unavailable, stop; do not paste this identity token into chat.',
    },
    {
      name: 'Grok',
      manual: true,
      // allowlist: connector placeholder paste
      config:
        'OAuth connector setup is coming in a separate update. Do not paste an identity token into a Grok conversation.',
      // allowlist: agent paste instruction
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
    button.title = t('connect.action.revealTheIdentityTokenBeforeCopying');
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
      ? t('connect.copy.manualConnection')
      : definition.location;
    var config = document.createElement('pre');
    config.className = 'connect-config';
    var configCode = document.createElement('code');
    configCode.textContent = redactConnectText(definition.config);
    config.append(configCode);
    var configCopy = connectCopyButton(
      t('connect.copy.copySetup'),
      definition.config,
      configCode,
      !definition.manual,
    );
    var promptLabel = document.createElement('h4');
    promptLabel.textContent = t('connect.action.pasteToYourAgent');
    var prompt = document.createElement('p');
    prompt.className = 'connect-prompt';
    prompt.textContent = definition.prompt;
    var promptCopy = connectCopyButton(
      t('connect.copy.copyInstruction'),
      // i案：只复制 prompt 文案，绝不附带 config/token
      definition.prompt,
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
  // 失效在途 loadConnectPage（含 logout / 离页 / 重进）
  connectLoadGen += 1;
  connectCredentialValue = '';
  connectEndpointValue = '';
  connectRevealed = false;
  connectToken.textContent = '••••••••••••';
  connectTokenReveal.textContent = t('connect.action.reveal');
  connectTokenReveal.setAttribute('aria-pressed', 'false');
  connectTokenCopy.disabled = true;
  connectEndpoint.textContent = '';
  connectIdentity.textContent = '';
  connectCredential.hidden = true;
  connectCards.replaceChildren();
}

async function loadConnectPage() {
  clearConnectSensitiveState();
  var generation = connectLoadGen;
  connectState.textContent = t('connect.action.loadingConnectionDetails');
  try {
    var payload = await apiJson('/ui/api/connect');
    // 双闸：仍在 connect scope，且代际未被 logout/离页作废
    if (state.scope !== 'connect' || generation !== connectLoadGen) return;
    connectEndpointValue = payload.endpoint || '';
    connectEndpoint.textContent = connectEndpointValue;
    if (payload.unavailable === 'identity_session_required') {
      connectState.textContent = t('connect.copy.signInWithAnIdentityToken');
      return;
    }
    connectIdentity.textContent = payload.identity || '';
    if (payload.unavailable === 'token_unavailable' || !payload.token) {
      connectState.textContent = t('connect.copy.thisSessionWasRestoredWithoutA');
      return;
    }
    connectCredentialValue = payload.token;
    connectCredential.hidden = false;
    // nit：主「Copy token」钮与五卡 copy 同逻辑——遮蔽态保持 disabled
    connectTokenCopy.disabled = true;
    connectTokenCopy.title = t('connect.action.revealTheIdentityTokenBeforeCopying');
    connectState.textContent = t('connect.copy.revealTheTokenToEnableReady');
    renderConnectCards();
  } catch (error) {
    if (generation !== connectLoadGen) return;
    if (error.message !== 'session_expired') {
      connectState.textContent = t('connect.error.connectionDetailsCouldNotBeLoaded');
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
  connectTokenReveal.textContent = connectRevealed ? t('connect.action.hide') : t('connect.action.reveal');
  connectTokenReveal.setAttribute('aria-pressed', String(connectRevealed));
  // 与 connectCopyButton 对齐：仅 reveal 后允许复制明文 token
  connectTokenCopy.disabled = !connectRevealed;
  if (connectTokenCopy.disabled) {
    connectTokenCopy.title = t('connect.action.revealTheIdentityTokenBeforeCopying');
  } else {
    connectTokenCopy.removeAttribute('title');
  }
  renderConnectCards();
  announce(
    connectRevealed
      ? t('connect.copy.identityTokenRevealed')
      : t('connect.copy.identityTokenHidden'),
  );
});

connectTokenCopy.addEventListener('click', function () {
  // 双保险：遮蔽态即使被强制启用也不交出真值
  if (!connectCredentialValue || !connectRevealed) return;
  copyValue(connectCredentialValue, connectToken, connectTokenCopy);
});

// R4/R5：bfcache 会冻住 JS 堆+DOM；SPA 离页清态走不到整页离开。
// pagehide 清敏感态；pageshow persisted 且仍在 connect 时重拉面板（仍遮蔽，须 Reveal）。
window.addEventListener('pagehide', function () {
  clearConnectSensitiveState();
});

window.addEventListener('pageshow', function (event) {
  if (!event.persisted) return;
  if (state.scope === 'connect') {
    // R5：数据重来、token 仍需 reveal；安全姿态不变（返回 Promise 便于测）
    return loadConnectPage();
  }
  clearConnectSensitiveState();
});
