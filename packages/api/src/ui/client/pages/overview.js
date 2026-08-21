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
    /* 通知数字卡与 Notifications 今日小结同一 /ui/api/notify/summary 源。 */
    var notifySummary = state.notifySummary;
    var notifyPending = state.notifySummaryStatus === 'loading' || state.notifySummaryStatus === 'idle';
    card('Notifications today', notifySummary
      ? { text: formatNumber(notifySummary.total) }
      : { text: notifyPending ? 'Loading…' : 'Unavailable' });
    card('Urgent today', notifySummary
      ? { text: formatNumber(notifySummary.ringCount) }
      : { text: notifyPending ? 'Loading…' : 'Unavailable' });
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
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_err) {}
    var notifySummaryPromise = apiJson(
      '/ui/api/notify/summary?date=today&tz=' + encodeURIComponent(tz),
      { signal: signal }
    );
    state.notifySummaryStatus = 'loading';
    notifySummaryPromise.then(function (payload) {
      if (generation !== state.overviewGen) return;
      state.notifySummary = payload;
      state.notifySummaryStatus = 'ready';
      if (state.scope === 'overview') renderOverviewStats();
    }).catch(function (error) {
      if (generation !== state.overviewGen) return;
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      state.notifySummaryStatus = 'error';
      if (state.scope === 'overview') renderOverviewStats();
    });

    identitiesPromise.then(function (payload) {
      if (generation !== state.overviewGen) return;
      state.identities = Array.isArray(payload.identities) ? payload.identities : [];
      /* 侧栏与总览行都吃这份名单，两边都得重画（只重画总览会让侧栏一直空着）。 */
      renderIdentities();
      renderOverview();
      refreshConfigureSurfaces();
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
    applyScope('overview', { announce: opts.announce, skipUrl: opts.skipUrl, replaceUrl: opts.replaceUrl });
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
    applyScope('inbox', { replaceUrl: true });
    inboxView.dataset.mobileView = 'list';
    announce('Opened ' + address);
    messagesTitle.focus();
    selectIdentity(address);
  }

