  /* ---- Configure · Push & Devices（PR5：人话三档卡；PR6：设备列表 / 添加引导 / 一次性 QR；tier 三卡保持不动） ---- */
  var PUSH_TIER_CARDS = [
    {
      tier: 1,
      title: 'Notify only',
      summary: 'Just tell me a message arrived.',
      detail: 'The push says mail is waiting. No sender, subject, or body leaves this server.'
    },
    {
      tier: 2,
      title: 'Sender & subject',
      summary: 'Also include From and Subject.',
      detail: 'Enough to decide whether to open the inbox. Body and OTP codes stay on this server.'
    },
    {
      tier: 3,
      title: 'Body & OTP',
      summary: 'Also include body preview and verification codes.',
      detail: 'Sensitive: body previews and OTP codes/links leave this server for the ntfy channel. Enabling this tier requires an explicit risk confirmation that the server enforces.'
    }
  ];

  function configurePushTarget() {
    if (state.configurePushAddress) {
      for (var i = 0; i < state.identities.length; i++) {
        if (state.identities[i].address === state.configurePushAddress) return state.identities[i];
      }
    }
    return state.identities[0] || null;
  }

  function handleConfigurePushTier(address, next) {
    if (!isAdmin()) return;
    if (state.tierPending[address]) return;
    var identity = null;
    for (var i = 0; i < state.identities.length; i++) {
      if (state.identities[i].address === address) {
        identity = state.identities[i];
        break;
      }
    }
    var previous = identity ? currentPushTier(identity) : 1;
    if (next === previous) return;

    async function apply(tier, confirmRisk, openedGen) {
      if (state.tierPending[address]) {
        announce('Another push content change is already in progress for ' + address + '.');
        return;
      }
      state.tierPending[address] = true;
      renderConfigurePush();
      try {
        await savePushContentTier(address, tier, confirmRisk);
        announce('Push content set to tier ' + tier + ' for ' + address + '.');
        /* 先关确认框再重绘，避免 replaceChildren 卸掉 modalOpener。 */
        if (openedGen !== undefined) {
          if (openedGen !== modalGeneration) return;
          if (!confirmModal.hidden) {
            confirmModalOnCancel = null;
            closeAllModals({ skipFocus: true });
          }
        }
        renderConfigurePush();
        if (state.scope === 'configure-identities') renderConfigureIdentities();
        if (state.scope === 'configure-push' && !configurePushPanel.hidden) {
          var selectedCard = configurePushCards.querySelector('.push-tier-card.is-selected');
          if (selectedCard && typeof selectedCard.focus === 'function') selectedCard.focus();
        }
      } catch (error) {
        if (
          error.status === 400 &&
          error.body &&
          error.body.error === 'confirm_risk_required'
        ) {
          announce('Tier 3 requires explicit risk confirmation.');
          renderConfigurePush();
        } else if (error.message === 'session_expired') {
          renderConfigurePush();
        } else {
          // Fuzzy failure (network/parse/5xx): PUT 可能已落盘，必须拉权威档再画。
          var recovered = await recoverPushTier(address);
          if (recovered.status === 'stale') return;
          renderConfigurePush();
          if (recovered.status !== 'error') {
            if (state.scope === 'configure-identities') renderConfigureIdentities();
            if (state.scope === 'overview') renderOverviewRows();
          }
        }
      } finally {
        delete state.tierPending[address];
        renderConfigurePush();
        /* 中途切到 Overview 时，行上的 select 仍可能停在 disabled + 旧档。 */
        if (state.scope === 'overview') renderOverviewRows();
        if (state.scope === 'configure-push' && !configurePushPanel.hidden && confirmModal.hidden) {
          var focusCard = configurePushCards.querySelector('.push-tier-card.is-selected');
          if (focusCard && typeof focusCard.focus === 'function') focusCard.focus();
        }
      }
    }

    if (next !== 3) {
      apply(next, false);
      return;
    }

    var openedGen = beginModal();
    confirmModalTitle.textContent = 'Enable sensitive push content';
    confirmModalText.textContent =
      'Enable tier 3 for ' + address + '? Body previews and OTP codes/links will leave this server.';
    confirmModalRisk.textContent = PUSH_TIER3_WARNING;
    confirmModalRisk.hidden = false;
    confirmModalConfirm.textContent = 'Enable tier 3';
    confirmModal.hidden = false;
    /* 卡面在 apply() 前未改档；取消时不要 replaceChildren，否则 opener 被卸下无法回焦。 */
    confirmModalOnCancel = null;
    confirmModalConfirm.onclick = async function () {
      confirmModalConfirm.disabled = true;
      confirmModalCancel.disabled = true;
      try {
        /* 服务端强制 confirm_risk：此处必须传 true，前端绕过会 400。 */
        await apply(3, true, openedGen);
        if (openedGen !== modalGeneration) return;
      } finally {
        /* 仅当前代际才复位 Confirm+Cancel；新窗由 beginModal 统一拉回可点。 */
        if (openedGen === modalGeneration) {
          confirmModalConfirm.disabled = false;
          confirmModalCancel.disabled = false;
        }
      }
    };
    confirmModalConfirm.focus();
  }

  function renderConfigurePush() {
    var target = configurePushTarget();
    if (target) state.configurePushAddress = target.address;
    configurePushIdentityWrap.hidden = !isAdmin() || state.identities.length < 2;
    configurePushIdentity.replaceChildren();
    state.identities.forEach(function (identity) {
      var option = document.createElement('option');
      option.value = identity.address;
      option.textContent = identity.address;
      if (target && identity.address === target.address) option.selected = true;
      configurePushIdentity.append(option);
    });
    configurePushCards.replaceChildren();
    if (!target) {
      configurePushState.textContent = 'Create an identity before choosing a push tier.';
      configurePushCards.replaceChildren();
      renderPairedDevices();
      return;
    }
    configurePushState.textContent = '';
    var current = currentPushTier(target);
    var pending = !!state.tierPending[target.address];
    var currentLabel = document.createElement('p');
    currentLabel.className = 'sr-only';
    currentLabel.id = 'configure-push-tier-current';
    currentLabel.textContent = 'Current push content: ' + pushTierProjection(current);
    configurePushCards.append(currentLabel);
    configurePushCards.setAttribute('role', 'radiogroup');
    configurePushCards.setAttribute('aria-label', 'Push content for ' + target.address);
    configurePushCards.setAttribute('aria-describedby', 'configure-push-tier-current');
    configurePushCards.setAttribute('aria-readonly', isAdmin() ? 'false' : 'true');
    PUSH_TIER_CARDS.forEach(function (def) {
      var selected = def.tier === current;
      var node = document.createElement(isAdmin() ? 'button' : 'div');
      if (isAdmin()) node.type = 'button';
      node.className = 'push-tier-card' + (selected ? ' is-selected' : '');
      node.setAttribute('role', 'radio');
      node.setAttribute('aria-checked', selected ? 'true' : 'false');
      if (isAdmin()) {
        node.disabled = pending;
        node.addEventListener('click', function () {
          handleConfigurePushTier(target.address, def.tier);
        });
      } else {
        node.setAttribute('aria-disabled', 'true');
      }
      var kicker = document.createElement('p');
      kicker.className = 'push-tier-kicker';
      kicker.textContent = 'Tier ' + def.tier;
      var title = document.createElement('h3');
      title.textContent = def.title;
      var summary = document.createElement('p');
      summary.className = 'push-tier-summary';
      summary.textContent = def.summary;
      var detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent = def.detail;
      node.append(kicker, title, summary, detail);
      if (def.tier === 3) {
        var risk = document.createElement('p');
        risk.className = 'push-tier-risk';
        risk.textContent = selected
          ? 'Active. Body previews and OTP codes leave this server.'
          : 'Requires an explicit risk confirmation. The server rejects the change without it.';
        node.append(risk);
      }
      configurePushCards.append(node);
    });
    renderPairedDevices();
  }


  function topicSemantics(device) {
    var labels = device && device.topicLabels ? device.topicLabels : {};
    var parts = [];
    if (labels.userAlerts) parts.push(labels.userAlerts);
    if (labels.userLow) parts.push(labels.userLow);
    return parts.length ? parts.join(' · ') : 'User alerts · User low';
  }

  function paintDeviceQr(qr) {
    devicePairQr.replaceChildren();
    if (!qr || !qr.modules || !qr.size) return;
    var size = qr.size;
    var modules = qr.modules;
    if (modules.length !== size * size) return;
    var scale = size > 45 ? 3 : 4;
    var quiet = 4;
    var canvas = document.createElement('canvas');
    canvas.width = (size + quiet * 2) * scale;
    canvas.height = (size + quiet * 2) * scale;
    canvas.className = 'device-qr-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111111';
    var y;
    var x;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        if (modules.charAt(y * size + x) === '1') ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
    devicePairQr.append(canvas);
  }

  function showDeviceAddModal() {
    if (!isAdmin()) return;
    beginModal();
    deviceAddName.value = '';
    deviceAddModal.hidden = false;
    deviceAddName.focus();
  }

  function showDevicePairModal(created) {
    beginModal();
    devicePairName.textContent = created.displayName
      ? 'Device: ' + created.displayName
      : '';
    devicePairServer.textContent = created.serverUrl || (created.qrPayload && created.qrPayload.serverUrl) || '';
    devicePairUser.textContent = created.username || (created.qrPayload && created.qrPayload.username) || '';
    devicePairPassword.textContent = created.password || (created.qrPayload && created.qrPayload.password) || '';
    devicePairTopics.textContent = topicSemantics({
      topicLabels: { userAlerts: 'User alerts', userLow: 'User low' }
    });
    paintDeviceQr(created.qr);
    devicePairModal.hidden = false;
    devicePairCopy.focus();
  }

  async function handleDeviceAddSubmit() {
    if (!isAdmin()) return;
    var openedGen = modalGeneration;
    var displayName = deviceAddName.value.trim();
    deviceAddSubmit.disabled = true;
    try {
      var created = await apiJson('/ui/api/notify/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(displayName ? { displayName: displayName } : {})
      });
      if (openedGen !== modalGeneration) return;
      showDevicePairModal(created);
      loadPairedDevices();
    } catch (error) {
      if (openedGen !== modalGeneration) return;
      if (error.message === 'session_expired') return;
      if (error.body && (error.body.error === 'notifications_disabled' || error.body.error === 'notifications_unconfigured')) {
        announce('Notifications are not configured on this instance.');
      } else {
        announce('Could not create device credentials. Try again.');
      }
    } finally {
      if (openedGen === modalGeneration) deviceAddSubmit.disabled = false;
    }
  }

  function handleRevokeDevice(device) {
    if (!isAdmin()) return;
    var openedGen = beginModal();
    confirmModalTitle.textContent = 'Revoke device?';
    confirmModalText.textContent =
      'This deletes the ntfy login for ' +
      (device.displayName || 'this device') +
      '. Push to that phone stops immediately.';
    confirmModalRisk.hidden = true;
    confirmModalConfirm.textContent = 'Revoke';
    confirmModal.hidden = false;
    confirmModalConfirm.onclick = async function () {
      confirmModalConfirm.disabled = true;
      confirmModalCancel.disabled = true;
      try {
        await apiJson('/ui/api/notify/devices/' + encodeURIComponent(device.id), { method: 'DELETE' });
        if (openedGen !== modalGeneration) return;
        closeAllModals();
        announce('Device revoked.');
        loadPairedDevices();
      } catch (error) {
        if (openedGen !== modalGeneration) return;
        if (error.message === 'session_expired') return;
        /* ntfy 临时关闭时凭据可能仍活着，不要说成普通失败。 */
        if (error.body && (error.body.error === 'notifications_disabled' || error.body.error === 'notifications_unconfigured')) {
          announce('Restore ntfy admin access before revoking. The phone may still receive notifications.');
        } else {
          announce('Could not revoke that device. Try again.');
        }
        /* transient 已落 pending_revoke：立刻重拉，让 Revoking… 马上可见。 */
        loadPairedDevices();
      } finally {
        /* 仅当前代际才复位；stale 请求不得复活新 dialog 的共享钮。 */
        if (openedGen === modalGeneration) {
          confirmModalConfirm.disabled = false;
          confirmModalCancel.disabled = false;
        }
      }
    };
    confirmModalConfirm.focus();
  }

  function renderPairedDevices() {
    if (configurePushAdd) configurePushAdd.hidden = !isAdmin();
    configurePushDeviceList.replaceChildren();
    if (!isAdmin()) {
      configurePushDevicesState.textContent = 'Only the instance admin can manage paired devices.';
      return;
    }
    if (state.devicesStatus === 'loading' && !state.devices.length) {
      configurePushDevicesState.textContent = 'Loading…';
      return;
    }
    if (state.devicesStatus === 'error') {
      configurePushDevicesState.textContent = 'Could not load paired devices.';
      return;
    }
    var devices = Array.isArray(state.devices) ? state.devices : [];
    if (!devices.length) {
      configurePushDevicesState.textContent = 'No paired devices yet. Add a phone to get a one-time password and QR.';
      return;
    }
    configurePushDevicesState.textContent = '';
    devices.forEach(function (device) {
      var row = document.createElement('div');
      row.className = 'device-row';
      var meta = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = device.displayName || 'Phone';
      var channels = document.createElement('p');
      channels.className = 'muted';
      channels.textContent = topicSemantics(device);
      var paired = document.createElement('p');
      paired.className = 'muted';
      var when = device.pairedAt ? formatDate(device.pairedAt) : '';
      paired.textContent = when ? ('Paired ' + when) : '';
      if (device.revokeStatus === 'pending_revoke') {
        var pending = document.createElement('p');
        pending.className = 'device-pending';
        pending.textContent = 'Revoking…';
        meta.append(title, channels, paired, pending);
      } else {
        meta.append(title, channels, paired);
      }
      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'quiet';
      revoke.textContent = device.revokeStatus === 'pending_revoke' ? 'Retry revoke' : 'Revoke';
      revoke.addEventListener('click', function () {
        handleRevokeDevice(device);
      });
      row.append(meta, revoke);
      configurePushDeviceList.append(row);
    });
  }

  async function loadPairedDevices() {
    /* 每次发起占一新代际；乱序旧响应与登出后的飞行响应都不得写 state。 */
    var generation = ++state.deviceLoadGen;
    if (!isAdmin()) {
      if (generation !== state.deviceLoadGen) return;
      state.devices = [];
      state.devicesStatus = 'idle';
      renderPairedDevices();
      return;
    }
    state.devicesStatus = 'loading';
    renderPairedDevices();
    try {
      var payload = await apiJson('/ui/api/notify/devices');
      if (generation !== state.deviceLoadGen) return;
      state.devices = Array.isArray(payload.devices) ? payload.devices : [];
      state.devicesStatus = 'ready';
      renderPairedDevices();
    } catch (error) {
      if (generation !== state.deviceLoadGen) return;
      if (error.message === 'session_expired') return;
      state.devicesStatus = 'error';
      renderPairedDevices();
    }
  }

  function enterConfigurePush(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('configure-push', { announce: opts.announce });
    if (!state.configurePushAddress && state.identities[0]) {
      state.configurePushAddress = state.identities[0].address;
    }
    renderConfigurePush();
    loadPairedDevices();
    configurePushPanel.focus({ preventScroll: true });
  }

