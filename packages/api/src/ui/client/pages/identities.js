  /* ---- Configure · Identities & Tokens（PR5：单 slot + 一次性 token 仪式 + tier 投影） ---- */
  function currentPushTier(identity) {
    return identity.pushContentTier === 2 || identity.pushContentTier === 3
      ? identity.pushContentTier
      : 1;
  }

  function pushTierProjection(tier) {
    if (tier === 3) return 'Tier 3 · body & OTP';
    if (tier === 2) return 'Tier 2 · sender & subject';
    return 'Tier 1 · notify only';
  }

  function isConfigureScope(scope) {
    return scope === 'configure-identities' ||
      scope === 'configure-push' ||
      scope === 'configure-clients' ||
      scope === 'configure-domains' ||
      scope === 'plan';
  }

  /* Overview / Configure 共用：身份名单刷新后把可见 Configure 面重画一遍。 */
  function refreshConfigureSurfaces() {
    if (state.scope === 'configure-identities') renderConfigureIdentities();
    if (state.scope === 'configure-push') renderConfigurePush();
  }

  function renderConfigureIdentities() {
    configureIdentitiesRows.replaceChildren();
    if (!state.identities.length) {
      renderEmptyState(configureIdentitiesState, {
        title: 'No identities yet',
        purpose: isAdmin()
          ? 'Create an identity to get a one-time token. The plaintext token is shown once and never stored.'
          : 'No identity is visible in this session.',
        actionLabel: isAdmin() ? 'Create Identity' : '',
        onAction: isAdmin() ? showCreateModal : null
      });
      return;
    }
    configureIdentitiesState.replaceChildren();
    state.identities.forEach(function (identity) {
      var row = document.createElement('div');
      row.className = 'identity-config-row';
      var meta = document.createElement('div');
      meta.className = 'identity-config-meta';
      var addr = document.createElement('strong');
      addr.textContent = identity.address;
      var name = document.createElement('p');
      name.className = 'muted';
      name.textContent = identity.name || 'No display name';
      var token = document.createElement('p');
      token.className = 'identity-token-slot';
      /* 单 slot 诚实展示：只报 Set/Missing，永不回显旧 token 明文。 */
      token.textContent = identity.hasToken ? 'Token slot: Set' : 'Token slot: Missing';
      var tier = document.createElement('p');
      tier.className = 'muted';
      tier.textContent = 'Push: ' + pushTierProjection(currentPushTier(identity));
      meta.append(addr, name, token, tier);
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      if (isAdmin()) {
        var rotate = document.createElement('button');
        rotate.type = 'button';
        rotate.className = 'quiet';
        rotate.textContent = 'Rotate';
        rotate.addEventListener('click', function () { handleRotateToken(identity.address); });
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'quiet delete-action';
        del.textContent = 'Delete';
        del.addEventListener('click', function () { handleDeleteIdentity(identity.address); });
        actions.append(rotate, del);
      }
      row.append(meta, actions);
      configureIdentitiesRows.append(row);
    });
  }

  function enterConfigureIdentities(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('configure-identities', { announce: opts.announce });
    renderConfigureIdentities();
    configureIdentitiesPanel.focus({ preventScroll: true });
  }

