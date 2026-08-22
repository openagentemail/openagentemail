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
    state.notifyLogItems = [];
    state.notifyLogFetchKey = '';
    state.notifyNextCursor = '';
    state.notifyLevelFilter = '';
    state.notifyFrom = '';
    state.notifyTo = '';
    state.notifyLimit = 20;
    state.notifySource = 'log';
    state.notifySummary = null;
    state.notifySummaryStatus = 'idle';
    state.notifyDiagnostics = null;
    state.notifyRevealed = {};
    state.notifyVerifyPending = false;
    state.devices = [];
    state.devicesStatus = 'idle';
    /* 作废飞行中的设备列表请求，避免登出后旧响应写回上一会话。 */
    state.deviceLoadGen += 1;
  }

  /* 401 / 登出共用：清掉工单缓存，避免换主体后渲染上一会话任务。 */
  function clearTasksState() {
    state.tasks = [];
    state.tasksStatus = 'idle';
    state.tasksMessage = '';
    state.tasksFilter = 'input-required';
    state.tasksPeriod = '30d';
    state.tasksLimit = 20;
    state.tasksNextCursor = '';
    state.tasksTotalApprox = 0;
    state.tasksUpdatedAt = 0;
    state.tasksPending = false;
    state.tasksFetchKey = '';
    state.activeTaskId = '';
    state.taskDetail = null;
    state.taskDetailStatus = 'idle';
    state.taskDetailMessage = '';
  }

  function clearHomeState() {
    state.homeStatus = 'idle';
    state.homeMessage = '';
    state.homeWaitingTasks = [];
    state.homeWaitingTotal = 0;
    state.homeStuckTasks = [];
    state.homeFailedUrgentCount = 0;
    state.homeUrgentSentCount = null;
    state.homeUnseenCount = null;
    state.homeUpdatedAt = 0;
  }

  function showLogin(message) {
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    clearNotifyState();
    clearTasksState();
    clearHomeState();
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

  /* OAuth 同意页回跳：路径由服务端会话接口 JSON 下发（cookie），不读地址栏查询串。 */
  function consumeReturnTo(payload) {
    var path = payload && typeof payload.returnTo === 'string' ? payload.returnTo : '';
    /* 拒绝协议相对路径（两段斜杠开头）；字面量拆开以免触碰资产契约对 // 的禁令。 */
    if (!path || path.charAt(0) !== '/') return false;
    if (path.length >= 2 && path.charAt(1) === '/') return false;
    if (path.indexOf('/ui/') !== 0 && path !== '/ui') return false;
    window.location.replace(path);
    return true;
  }

  function isAdmin() {
    return Boolean(state.me) && state.me.kind === 'admin';
  }

  function configureSession() {
    inboxView.dataset.session = isAdmin() ? 'admin' : 'identity';
    backToOverview.hidden = false;
    createIdentityButton.hidden = !isAdmin();
    configureIdentitiesCreate.hidden = !isAdmin();
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
    /* 204/205 或空 body：成功但无 JSON（OAuth grant DELETE 等），勿无条件 response.json()。 */
    if (response.status === 204 || response.status === 205) return null;
    var raw = await response.text();
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async function handleCreateSubmit() {
    if (!isAdmin()) return;
    if (!createLocalpart.checkValidity()) {
      createLocalpart.reportValidity();
      return;
    }
    var openedGen = modalGeneration;
    var name = createName.value.trim();
    var localpart = createLocalpart.value.trim();
    createModalSubmit.disabled = true;
    try {
      var payload = await apiJson('/ui/api/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, localpart: localpart || undefined })
      });
      if (openedGen !== modalGeneration) return;
      showTokenModal(payload.token);
      await refreshInboxIdentities();
      loadHome({ refresh: false });
    } catch (error) {
      if (openedGen !== modalGeneration) return;
      if (error.status === 409) {
        window.alert('address already exists');
      } else if (error.message !== 'session_expired') {
        announce('Could not create the identity. Try again.');
      }
    } finally {
      /* 仅当前代际才复位：stale 请求不得复活新 dialog 的共享钮；新窗由 beginModal 复位。 */
      if (openedGen === modalGeneration) createModalSubmit.disabled = false;
    }
  }

  async function handleRotateToken(address) {
    var openedGen = modalGeneration;
    try {
      var payload = await apiJson(
        '/ui/api/identities/' + encodeURIComponent(address) + '/token',
        { method: 'POST' }
      );
      if (openedGen !== modalGeneration) return;
      showTokenModal(payload.token, 'Rotated Token');
      refreshInboxIdentities();
      loadHome({ refresh: false });
    } catch (error) {
      if (openedGen !== modalGeneration) return;
      if (error.message !== 'session_expired') {
        announce('Could not rotate the token. Try again.');
      }
    }
  }

  function handleDeleteIdentity(address) {
    if (!isAdmin()) return;
    var openedGen = beginModal();
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
        /* 不依赖可被 cancelOverview 中止的对账：删的若是当前 inbox 身份，立刻清掉。 */
        if (state.activeAddress === address) {
          state.activeAddress = '';
          state.messages = [];
          state.nextCursor = '';
          state.sourceCache = null;
          state.returnAddress = '';
          clearDetail();
          renderMessages();
          renderIdentities();
        }
        if (openedGen !== modalGeneration) return;
        closeAllModals();
        if (isConfigureScope(state.scope)) {
          announce(address + ' deleted.');
          refreshConfigureSurfaces();
        } else {
          enterOverview({ announce: address + ' deleted. Back to Home.' });
        }
        loadHome({ refresh: false });
      } catch (error) {
        if (openedGen !== modalGeneration) return;
        if (error.message !== 'session_expired') {
          announce('Could not delete the identity. Try again.');
        }
      } finally {
        /* 仅当前代际才复位：stale 请求不得复活新 dialog 的共享钮；新窗由 beginModal 复位。 */
        if (openedGen === modalGeneration) confirmModalConfirm.disabled = false;
      }
    };
    confirmModalConfirm.focus();
  }

  /* Invalidate in-flight overview identity loads so a stale /identities
     response cannot overwrite a local mutation (tier save, delete, …). */
  function bumpIdentityEpoch() {
    state.overviewGen += 1;
  }

  /* 模糊失败恢复：作废在途 identities 代际，再 GET 权威档。Overview 与 Configure 共用。 */
  async function recoverPushTier(address) {
    bumpIdentityEpoch();
    var recoveryGen = state.overviewGen;
    try {
      var payload = await apiJson('/ui/api/identities');
      if (recoveryGen !== state.overviewGen) return { status: 'stale' };
      state.identities = Array.isArray(payload.identities) ? payload.identities : [];
      var row = state.identities.find(function (identity) {
        return identity.address === address;
      });
      if (!row) {
        announce('Could not update push content tier. Try again.');
        return { status: 'missing' };
      }
      var authoritative =
        row.pushContentTier === 2 || row.pushContentTier === 3
          ? row.pushContentTier
          : 1;
      announce(
        'Push content tier is tier ' +
          authoritative +
          ' for ' +
          address +
          ' (refreshed).',
      );
      return { status: 'ok', authoritative: authoritative };
    } catch (_refreshErr) {
      if (recoveryGen !== state.overviewGen) return { status: 'stale' };
      announce('Could not update push content tier. Try again.');
      return { status: 'error' };
    }
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
      if (state.scope === 'overview') renderOverview();
      try {
        await savePushContentTier(address, tier, confirmRisk);
        selectEl.dataset.currentTier = String(tier);
        announce('Push content set to tier ' + tier + ' for ' + address + '.');
        renderOverview();
        // Restart overview only while still on Overview: unstick Refresh after
        // bumpIdentityEpoch, but do not revive overview polling after openAddress.
        if (state.scope === 'overview') {
          loadHome({ refresh: false });
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
          var recovered = await recoverPushTier(address);
          if (recovered.status === 'stale') return;
          if (recovered.status !== 'ok') {
            restore();
          } else {
            selectEl.value = String(recovered.authoritative);
            selectEl.dataset.currentTier = String(recovered.authoritative);
            renderOverview();
          }
        }
      } finally {
        delete state.tierPending[address];
        selectEl.disabled = false;
        // Re-render so a select recreated mid-flight drops disabled correctly.
        if (state.scope === 'overview') renderOverview();
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
        if (openedGen !== modalGeneration) return;
        // F107: confirmed — consume the pending restore before closeAllModals
        // would run it and drop the select back to the old tier.
        confirmModalOnCancel = null;
        closeAllModals();
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
    state.sourceCache = null;
    detailContent.replaceChildren();
    var placeholder = document.createElement('div');
    placeholder.className = 'empty-state-card';
    var title = document.createElement('h3');
    title.textContent = 'Read a message';
    var purpose = document.createElement('p');
    purpose.className = 'muted';
    purpose.textContent = 'This pane shows the selected email: codes and links first, then Rendered, Plain text, or Source. HTML stays in an isolated frame.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary empty-state-action';
    btn.textContent = 'Open the latest message';
    btn.addEventListener('click', function () {
      if (state.messages[0]) selectMessage(state.messages[0].id);
    });
    placeholder.append(title, purpose, btn);
    detailContent.append(placeholder);
  }
