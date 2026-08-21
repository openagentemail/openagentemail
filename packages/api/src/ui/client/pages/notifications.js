  /* ---- 通知记录面板：30 天本地日志为主，12h ntfy 仅作 transport cache fallback ---- */
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

  function notifyTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_err) {
      return 'UTC';
    }
  }

  function notifyLogFetchKey() {
    return [
      state.notifyFilter || '',
      state.notifyLevelFilter || '',
      state.notifyFrom || '',
      state.notifyTo || '',
      String(state.notifyLimit || 20)
    ].join('|');
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

  function populateNotifyExtraFilters() {
    if (notifyLevelFilter) {
      notifyLevelFilter.value = state.notifyLevelFilter || '';
    }
    if (notifyLimitFilter) {
      notifyLimitFilter.value = String(state.notifyLimit || 20);
    }
    if (notifyFromInput) notifyFromInput.value = state.notifyFrom || '';
    if (notifyToInput) notifyToInput.value = state.notifyTo || '';
  }

  function isoFromDateInput(value, endOfDay) {
    if (!value) return '';
    var suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
    var local = new Date(value + suffix);
    if (isNaN(local.getTime())) return '';
    return local.toISOString();
  }

  function renderNotifySummaryBar() {
    if (!notifySummary) return;
    var summary = state.notifySummary;
    if (!summary) {
      notifySummary.textContent = state.notifySummaryStatus === 'loading'
        ? 'Loading today’s summary…'
        : '';
      return;
    }
    notifySummary.textContent = 'Today (' + summary.tz + '): ' +
      summary.total + ' sent · ' + summary.ringCount + ' urgent' +
      (summary.lastSuccessfulAt ? ' · last ' + formatClock(summary.lastSuccessfulAt, true) : '');
  }

  function renderNotifyDiagnostics() {
    if (!notifyDiagnostics) return;
    var diag = state.notifyDiagnostics;
    if (!diag) {
      notifyDiagnostics.textContent = '';
      if (notifyVerify) notifyVerify.hidden = true;
      return;
    }
    var parts = [];
    if (!diag.enabled) parts.push('Push transport is disabled on this server.');
    else if (!diag.configured) parts.push('Push transport is not configured on this server.');
    else parts.push('Push transport is enabled.');
    if (diag.lastSuccessfulAt) {
      parts.push('Last successful send ' + formatClock(diag.lastSuccessfulAt, true) + '.');
    } else {
      parts.push('No successful send in the 30-day log yet.');
    }
    notifyDiagnostics.textContent = parts.join(' ');
    if (notifyVerify) {
      notifyVerify.hidden = !diag.canVerify;
      notifyVerify.disabled = state.notifyVerifyPending || !diag.enabled || !diag.configured;
    }
  }

  function renderNotifyLogRows() {
    notifyRows.replaceChildren();
    var keyMatches = state.notifyLogFetchKey === notifyLogFetchKey();
    var rows = keyMatches ? state.notifyLogItems : [];
    var awaiting = state.notifyStatus === 'loading' || !keyMatches;
    notifyShown.textContent = awaiting ? '' : String(rows.length) + (state.notifyNextCursor ? '+' : '');
    if (notifyLoadMore) {
      renderLoadMore(notifyLoadMore, !awaiting && !!state.notifyNextCursor, function () {
        loadNotificationLog({ more: true });
      });
    }
    if (awaiting) {
      notifyStateNode.textContent = 'Loading…';
      return;
    }
    if (state.notifyStatus === 'error' && rows.length === 0) {
      notifyStateNode.textContent = state.notifyMessage || 'Notifications could not be loaded. Try Refresh.';
      return;
    }
    if (rows.length === 0) {
      renderEmptyState(notifyStateNode, {
        title: 'No notifications in this window',
        purpose: 'The 30-day log starts empty after deploy and does not backfill the 12-hour transport cache. Send a push or run Verify to accumulate history.',
        actionLabel: state.notifyDiagnostics && state.notifyDiagnostics.canVerify ? 'Send a test notification' : '',
        onAction: state.notifyDiagnostics && state.notifyDiagnostics.canVerify ? handleNotifyVerify : null
      });
      return;
    }
    notifyStateNode.textContent = '';
    var visibleLog = rows;
    visibleLog.forEach(function (row) {
      var item = document.createElement('article');
      item.className = 'notify-row';

      var whenCell = document.createElement('div');
      whenCell.className = 'cell notify-when';
      var whenLabel = document.createElement('span');
      whenLabel.className = 'cell-label';
      whenLabel.textContent = 'When';
      var whenValue = document.createElement('time');
      whenValue.dateTime = row.publishedAt || '';
      whenValue.textContent = row.publishedAt ? formatDate(row.publishedAt) : '—';
      whenCell.append(whenLabel, whenValue);

      var channelCell = document.createElement('div');
      channelCell.className = 'cell notify-channel';
      var channelLabel = document.createElement('span');
      channelLabel.className = 'cell-label';
      channelLabel.textContent = 'Channel';
      var channelValue = document.createElement('span');
      channelValue.textContent = formatNotifyChannel(row.logicalChannel);
      channelCell.append(channelLabel, channelValue);

      var tierCell = document.createElement('div');
      tierCell.className = 'cell';
      var tierLabel = document.createElement('span');
      tierLabel.className = 'cell-label';
      tierLabel.textContent = 'Level';
      var tierValue = document.createElement('span');
      tierValue.className = 'notify-tier';
      tierValue.setAttribute('data-tier', row.level || 'unknown');
      tierValue.textContent = row.level || 'unknown';
      tierCell.append(tierLabel, tierValue);

      var contentCell = document.createElement('div');
      contentCell.className = 'cell notify-content';
      var contentLabel = document.createElement('span');
      contentLabel.className = 'cell-label';
      contentLabel.textContent = 'Content';
      var title = document.createElement('p');
      title.className = 'notify-title-text';
      title.textContent = row.title || '(no title)';
      var body = document.createElement('div');
      body.className = 'notify-body-text';
      var revealed = !!state.notifyRevealed[row.id];
      renderSensitiveText(body, row.message || '', {
        sensitive: !!row.sensitive,
        expanded: revealed,
        onToggle: function () {
          if (state.notifyRevealed[row.id]) delete state.notifyRevealed[row.id];
          else state.notifyRevealed[row.id] = true;
          renderNotify();
        }
      });
      contentCell.append(contentLabel, title, body);

      item.append(whenCell, channelCell, tierCell, contentCell);
      notifyRows.append(item);
    });
  }

  function renderNotifyRows() {
    if (state.notifySource === 'log' || state.notifyStatus === 'loading') {
      renderNotifyLogRows();
      return;
    }
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
    var cacheExplanation =
      'What we tried to send to your phone and computers in the last 12 hours. This is not a 30-day audit log.';
    notifyStateNode.textContent = truncated
      ? 'Showing latest ' + NOTIFY_RENDER_LIMIT + ' of ' + total + ' notifications. ' + cacheExplanation
      : cacheExplanation;
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
      var body = document.createElement('div');
      body.className = 'notify-body-text';
      /* transport cache 没有可靠 sensitive 标记：默认遮蔽，避免空日志期把 OTP 明文画出来。 */
      var cacheId = 'cache:' + (row.id || '') + ':' + String(row.time || 0);
      renderSensitiveText(body, row.message || '', {
        sensitive: true,
        expanded: !!state.notifyRevealed[cacheId],
        onToggle: function () {
          if (state.notifyRevealed[cacheId]) delete state.notifyRevealed[cacheId];
          else state.notifyRevealed[cacheId] = true;
          renderNotify();
        }
      });
      contentCell.append(contentLabel, title, body);

      item.append(whenCell, channelCell, tierCell, contentCell);
      notifyRows.append(item);
    });
  }

  function renderNotifyMeta() {
    if (notifySubtitle) {
      notifySubtitle.textContent = state.notifySource === 'cache'
        ? 'What we tried to send to your phone and computers in the last 12 hours. This is not a 30-day audit log.'
        : 'What we tried to send to your phone and computers';
    }
    renderNotifySummaryBar();
    renderNotifyDiagnostics();
    if (state.notifyUpdatedAt) {
      notifyUpdated.textContent = 'Updated ' + formatClock(new Date(state.notifyUpdatedAt).toISOString(), true);
    } else {
      notifyUpdated.textContent = '';
    }
    notifyNotice.hidden = !state.notifyMessage || state.notifyStatus !== 'error' ||
      (state.notifyLogItems.length === 0 && state.notifyMessages.length === 0);
    notifyNotice.textContent = notifyNotice.hidden ? '' : state.notifyMessage;
    notifyRefresh.disabled = state.notifyPending;
    notifyRefresh.textContent = state.notifyPending ? 'Refreshing…' : 'Refresh';
  }

  function renderNotify() {
    populateNotifyTopicFilter();
    populateNotifyExtraFilters();
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
    state.notifySource = 'cache';
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

  async function loadNotifySummary(signal) {
    state.notifySummaryStatus = 'loading';
    try {
      var payload = await apiJson(
        '/ui/api/notify/summary?date=today&tz=' + encodeURIComponent(notifyTimeZone()),
        { signal: signal }
      );
      state.notifySummary = payload;
      state.notifySummaryStatus = 'ready';
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      state.notifySummaryStatus = 'error';
    }
  }

  async function loadNotifyDiagnostics(signal) {
    try {
      var url = '/ui/api/notify/diagnostics';
      if (state.notifyFilter) url += '?channel=' + encodeURIComponent(state.notifyFilter);
      state.notifyDiagnostics = await apiJson(url, { signal: signal });
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      state.notifyDiagnostics = null;
    }
  }

  async function loadNotificationLog(options) {
    var opts = options || {};
    cancelNotifyLoad();
    var controller = new AbortController();
    notifyController = controller;
    state.notifyPending = true;
    state.notifyMessage = '';
    state.notifySource = 'log';
    var fetchKey = notifyLogFetchKey();
    if (!opts.more && state.notifyLogFetchKey !== fetchKey) {
      state.notifyLogItems = [];
      state.notifyNextCursor = '';
      state.notifyStatus = 'loading';
    } else if (!opts.more && state.notifyLogItems.length === 0) {
      state.notifyStatus = 'loading';
    }
    renderNotify();
    try {
      if (isAdmin() && state.identities.length === 0) {
        var identityPayload = await apiJson('/ui/api/identities', { signal: controller.signal });
        if (controller.signal.aborted || notifyController !== controller) return;
        state.identities = Array.isArray(identityPayload.identities)
          ? identityPayload.identities
          : [];
        renderIdentities();
      }
      var params = ['limit=' + encodeURIComponent(String(state.notifyLimit || 20))];
      if (state.notifyFilter) params.push('channel=' + encodeURIComponent(state.notifyFilter));
      if (state.notifyLevelFilter) params.push('level=' + encodeURIComponent(state.notifyLevelFilter));
      var fromIso = isoFromDateInput(state.notifyFrom, false);
      var toIso = isoFromDateInput(state.notifyTo, true);
      if (fromIso) params.push('from=' + encodeURIComponent(fromIso));
      if (toIso) params.push('to=' + encodeURIComponent(toIso));
      if (opts.more && state.notifyNextCursor) {
        params.push('cursor=' + encodeURIComponent(state.notifyNextCursor));
      }
      var payload = await apiJson('/ui/api/notifications?' + params.join('&'), {
        signal: controller.signal
      });
      if (notifyController !== controller) return;
      var incoming = Array.isArray(payload.items) ? payload.items : [];
      if (opts.more) {
        var seen = {};
        state.notifyLogItems.forEach(function (row) { seen[row.id] = true; });
        incoming.forEach(function (row) {
          if (!seen[row.id]) state.notifyLogItems.push(row);
        });
      } else {
        state.notifyLogItems = incoming;
      }
      state.notifyNextCursor = payload.nextCursor || '';
      state.notifyLogFetchKey = fetchKey;
      state.notifyUpdatedAt = Date.now();
      state.notifyStatus = 'ready';
      state.notifyMessage = '';
      await loadNotifySummary(controller.signal);
      await loadNotifyDiagnostics(controller.signal);
      if (notifyController !== controller) return;
      if (
        !opts.more &&
        state.notifyLogItems.length === 0 &&
        !state.notifyFilter &&
        !state.notifyLevelFilter &&
        !state.notifyFrom &&
        !state.notifyTo
      ) {
        /* 未筛选且 30 天日志为空：12h transport cache 作 fallback，不回填日志。 */
        await loadNotifyHistory();
        return;
      }
      renderNotify();
      announce(state.notifyLogItems.length + ' notifications loaded');
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.notifyLogItems.length === 0) {
        state.notifyStatus = 'error';
        state.notifyMessage = 'Notifications could not be loaded. Try Refresh.';
        state.notifyLogFetchKey = fetchKey;
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

  async function handleNotifyVerify() {
    if (!notifyVerify || notifyVerify.hidden || state.notifyVerifyPending) return;
    state.notifyVerifyPending = true;
    notifyVerify.disabled = true;
    notifyVerify.textContent = 'Sending…';
    try {
      await apiJson('/ui/api/notify/verify', { method: 'POST' });
      announce('Test notification sent.');
      await loadNotificationLog({ force: true });
    } catch (error) {
      if (error.message === 'session_expired') return;
      announce('Test notification failed.');
    } finally {
      state.notifyVerifyPending = false;
      if (notifyVerify) notifyVerify.textContent = 'Send test';
      renderNotifyDiagnostics();
    }
  }

  function enterNotifications(options) {
    var opts = options || {};
    cancelOverview();
    cancelTasksLoad();
    applyScope('notifications', { announce: opts.announce, skipUrl: opts.skipUrl, replaceUrl: opts.replaceUrl });
    renderNotify();
    focusNotifyPanel();
    /* 15s 内有成功缓存且筛选未变则只重绘，避免 All 误用单路缓存。 */
    var age = state.notifyUpdatedAt ? Math.max(0, Date.now() - state.notifyUpdatedAt) : Infinity;
    if (
      state.notifyStatus === 'ready' &&
      age < FRESH_MS &&
      state.notifySource === 'log' &&
      state.notifyLogFetchKey === notifyLogFetchKey()
    ) return;
    loadNotificationLog();
  }
