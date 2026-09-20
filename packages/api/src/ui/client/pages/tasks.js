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
    label.textContent = t('tasks.action.taskTicket');
    var title = document.createElement('h2');
    title.textContent = t('tasks.detail.selectTask');
    var copy = document.createElement('p');
    copy.className = 'muted';
    copy.textContent = t('tasks.action.chooseATicketToInspectIts');
    placeholder.append(label, title, copy);
    tasksDetailContent.append(placeholder);
  }

  function tasksFetchKey() {
    return [
      state.tasksFilter || 'input-required',
      state.tasksPeriod || '30d',
      String(state.tasksLimit || 20)
    ].join('|');
  }

  function taskIsClosed(task) {
    return !!(task && task.result && task.result.closed_by_admin === true);
  }

  /* 只读投影：过期未物化不得再标成「等你批」。 */
  function approvalPastDeadline(task) {
    return !!(task && task.expiryProjection === 'past-deadline-unmaterialized');
  }

  function taskStateLabel(task) {
    if (taskIsClosed(task)) return t('tasks.state.closed');
    if (approvalPastDeadline(task)) return t('tasks.copy.pastDeadline');
    var s = task && task.state ? String(task.state) : '';
    if (!s) return '—';
    var key = 'tasks.state.' + s;
    var mapped = t(key);
    return mapped === key ? s : mapped;
  }

  /** timeline / 通用状态令牌 → 可见文案（协议值仍在 data-state）。 */
  function taskStateDisplay(stateToken) {
    var s = stateToken ? String(stateToken) : '';
    if (!s) return '—';
    var key = 'tasks.state.' + s;
    var mapped = t(key);
    return mapped === key ? s : mapped;
  }

  function taskStateToken(task) {
    if (taskIsClosed(task)) return 'closed';
    if (approvalPastDeadline(task)) return 'past-deadline';
    return task && task.state ? task.state : '';
  }

  function syncTasksFilters() {
    if (tasksStatusTabs) {
      var buttons = tasksStatusTabs.querySelectorAll('[data-status]');
      Array.prototype.forEach.call(buttons, function (button) {
        var selected = button.getAttribute('data-status') === (state.tasksFilter || 'input-required');
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    }
    if (tasksPeriodFilter) tasksPeriodFilter.value = state.tasksPeriod || '30d';
    if (tasksLimitFilter) tasksLimitFilter.value = String(state.tasksLimit || 20);
  }

  function renderTasksMeta() {
    if (state.tasksUpdatedAt) {
      tasksUpdated.textContent = t('tasks.action.updated') + formatClock(new Date(state.tasksUpdatedAt).toISOString(), true);
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
    tasksRefresh.textContent = state.tasksPending ? t('tasks.action.refreshing') : t('tasks.action.refresh');
    syncTasksFilters();
    if (typeof renderLoadMore === 'function' && tasksLoadMore) {
      renderLoadMore(tasksLoadMore, !!state.tasksNextCursor && state.tasksStatus === 'ready', function () {
        loadTasks({ more: true });
      });
    }
  }

  /*
   * 展示层剥离 result 块：口径对齐 lib/tasks.ts readResult——
   * lastIndexOf + 尾部 fenced json + JSON.parse 成功才剥（malformed 当普通正文；中途字面量不剥）。
   * UI_JS 外层是模板字符串：fence 用 RegExp + fromCharCode(96) 拼反引号，避免打断 backtick。
   */
  function taskTimelineBody(body) {
    var text = typeof body === 'string' ? body : '';
    var markerAt = text.lastIndexOf(TASK_RESULT_MARKER);
    if (markerAt < 0) return text;
    var after = text.slice(markerAt + TASK_RESULT_MARKER.length);
    var ticks = String.fromCharCode(96, 96, 96);
    var fence = new RegExp('^\\s*' + ticks + 'json\\s*\\n([\\s\\S]*?)\\n' + ticks + '\\s*$');
    var match = after.match(fence);
    if (!match) return text;
    try {
      JSON.parse(match[1]);
    } catch (_err) {
      return text;
    }
    return text.slice(0, markerAt).replace(/\s+$/, '');
  }

  function formatTaskResultValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }

  /* RESULT 形态：普通对象走键值表（与 notify/identity 行一致）；数组/标量才退回 <pre> JSON。 */
  function renderTaskResultNode(value) {
    var isPlainObject = !!value && typeof value === 'object' && !Array.isArray(value);
    if (isPlainObject) {
      var table = document.createElement('table');
      table.className = 'task-result-table';
      var body = document.createElement('tbody');
      Object.keys(value).forEach(function (key) {
        var row = document.createElement('tr');
        var th = document.createElement('th');
        th.textContent = key;
        var td = document.createElement('td');
        td.textContent = formatTaskResultValue(value[key]);
        row.append(th, td);
        body.append(row);
      });
      table.append(body);
      return table;
    }
    var pre = document.createElement('pre');
    pre.textContent = formatTaskResultValue(value);
    return pre;
  }

  function approvalCanDecide(task) {
    if (!task || task.kind !== 'approval' || !task.approval || task.state !== 'input-required') return false;
    // 过期未物化：列表/缓存详情不得再当可决策。
    if (approvalPastDeadline(task)) return false;
    return !isAdmin() && !!state.me &&
      String(state.me.address || '').toLowerCase() === String(task.approval.reviewer || '').toLowerCase();
  }

  var approvalDecisionInFlight = {};

  async function submitApprovalDecision(task, decision, buttons) {
    if (approvalDecisionInFlight[task.id]) return;
    approvalDecisionInFlight[task.id] = true;
    buttons.forEach(function (button) { button.disabled = true; });
    try {
      var updated = await apiJson('/ui/api/tasks/' + encodeURIComponent(task.id) + '/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: decision })
      });
      state.taskDetail = updated;
      state.taskDetailStatus = 'ready';
      renderTasks();
      loadTasks();
      announce(decision === 'approved' ? t('tasks.announce.approvalRecorded') : t('tasks.announce.rejectionRecorded'));
    } catch (error) {
      if (error.message !== 'session_expired') {
        announce(error.status === 409 ? t('tasks.announce.thisApprovalIsNoLongerPending') : t('tasks.announce.approvalDecisionCouldNotBeRecorded'));
      }
    } finally {
      delete approvalDecisionInFlight[task.id];
      buttons.forEach(function (button) { button.disabled = false; });
    }
  }

  function renderApprovalAction(task) {
    var approval = task.approval;
    if (!approval || !approval.action) return null;
    var section = document.createElement('section');
    section.className = 'task-approval';
    var title = document.createElement('h4');
    title.textContent = approvalPastDeadline(task)
      ? t('tasks.copy.approvalExpired')
      : task.state === 'input-required' ? t('tasks.copy.approvalRequired') : t('tasks.copy.approvalDetails');
    var type = document.createElement('p');
    type.textContent = t('tasks.action.type') + String(approval.action.type || '—');
    var name = document.createElement('p');
    name.textContent = t('tasks.action.name') + String(approval.action.name || '—');
    var args = document.createElement('pre');
    args.className = 'task-approval-arguments';
    try { args.textContent = JSON.stringify(approval.action.arguments); } catch (_err) { args.textContent = String(approval.action.arguments); }
    section.append(title, type, name, args);
    if (approvalCanDecide(task)) {
      var approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'primary';
      approve.setAttribute('aria-label', t('tasks.a11y.approveAction'));
      approve.textContent = t('tasks.action.approve');
      approve.addEventListener('click', function () { submitApprovalDecision(task, 'approved', [approve, reject]); });
      var reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'quiet delete-action';
      reject.setAttribute('aria-label', t('tasks.a11y.rejectAction'));
      reject.textContent = t('tasks.action.reject');
      reject.addEventListener('click', function () { submitApprovalDecision(task, 'rejected', [approve, reject]); });
      section.append(approve, reject);
    }
    return section;
  }

  function renderTaskRows() {
    tasksRows.replaceChildren();
    /* fetchKey 不匹配时旧缓存不可见，避免切筛选闪错位行。 */
    var keyMatches = state.tasksFetchKey === tasksFetchKey();
    var rows = keyMatches ? state.tasks : [];
    var awaiting = state.tasksStatus === 'loading' || !keyMatches;
    if (awaiting) {
      tasksShown.textContent = '';
      tasksStateNode.textContent = t('tasks.action.loading');
      return;
    }
    if (state.tasksStatus === 'error' && state.tasks.length === 0) {
      tasksShown.textContent = '';
      tasksStateNode.textContent = state.tasksMessage || t('tasks.error.tasksCouldNotBeLoadedTry');
      return;
    }
    var shown = rows.length;
    var total = typeof state.tasksTotalApprox === 'number' ? state.tasksTotalApprox : shown;
    tasksShown.textContent = shown === total ? String(shown) : shown + t('tasks.action.of') + total;
    if (rows.length === 0) {
      var filter = state.tasksFilter || 'input-required';
      tasksStateNode.textContent = filter === 'all'
        ? t('tasks.copy.noTasksInThisPeriodRefresh')
        : t('tasks.copy.noTasksIn') + filter + t('tasks.copy.forThisPeriod');
      return;
    }
    tasksStateNode.textContent = '';
    rows.forEach(function (task) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-row';
      if (task.overdueReason) button.classList.add('is-overdue');
      if (approvalPastDeadline(task)) button.classList.add('is-past-deadline');
      button.setAttribute('aria-current', task.id === state.activeTaskId ? 'true' : 'false');

      var stateCell = document.createElement('div');
      stateCell.className = 'cell';
      var stateLabel = document.createElement('span');
      stateLabel.className = 'cell-label';
      stateLabel.textContent = t('tasks.action.state');
      var badge = document.createElement('span');
      badge.className = 'task-badge';
      badge.setAttribute('data-state', taskStateToken(task));
      badge.textContent = taskStateLabel(task);
      stateCell.append(stateLabel, badge);
      if (task.overdueReason) {
        var overdue = document.createElement('span');
        overdue.className = 'task-overdue-flag';
        overdue.textContent = t('tasks.action.overdue');
        stateCell.append(overdue);
      }
      if (approvalPastDeadline(task)) {
        var expired = document.createElement('span');
        expired.className = 'task-expiry-flag';
        expired.textContent = t('tasks.copy.pastDeadline');
        stateCell.append(expired);
      }

      var peopleCell = document.createElement('div');
      peopleCell.className = 'cell task-participants';
      var peopleLabel = document.createElement('span');
      peopleLabel.className = 'cell-label';
      peopleLabel.textContent = t('tasks.action.participants');
      var peopleValue = document.createElement('span');
      peopleValue.textContent = (task.from || '—') + ' → ' + (task.to || '—');
      peopleCell.append(peopleLabel, peopleValue);

      var subjectCell = document.createElement('div');
      subjectCell.className = 'cell';
      var subjectLabel = document.createElement('span');
      subjectLabel.className = 'cell-label';
      subjectLabel.textContent = t('tasks.action.subject');
      var subjectValue = document.createElement('p');
      subjectValue.className = 'task-subject';
      subjectValue.textContent = task.subject || t('tasks.action.noSubject');
      subjectCell.append(subjectLabel, subjectValue);

      var updatedCell = document.createElement('div');
      updatedCell.className = 'cell task-updated';
      var updatedLabel = document.createElement('span');
      updatedLabel.className = 'cell-label';
      updatedLabel.textContent = t('tasks.action.updated2');
      var updatedValue = document.createElement('time');
      updatedValue.dateTime = task.updatedAt || '';
      updatedValue.textContent = formatAgo(task.updatedAt);
      updatedCell.append(updatedLabel, updatedValue);

      var hasLeaseAuthority = typeof task.claimedUntil === 'string' && typeof task.leaseGeneration === 'number';
      var hasActiveLease = hasLeaseAuthority && task.leaseStatus !== 'disabled';
      var hasDisabledLeaseAuthority = hasLeaseAuthority && task.leaseStatus === 'disabled';
      var leaseCell;
      if (hasActiveLease || hasDisabledLeaseAuthority) {
        leaseCell = document.createElement('div');
        leaseCell.className = 'cell';
        var leaseLabel = document.createElement('span');
        leaseLabel.className = 'cell-label';
        leaseLabel.textContent = hasDisabledLeaseAuthority ? t('tasks.action.leaseDisabled') : t('tasks.action.claimedUntil');
        var leaseValue = document.createElement('span');
        leaseValue.textContent = hasDisabledLeaseAuthority
          ? t('tasks.copy.retainedAuthorityUntil') + task.claimedUntil + t('tasks.copy.generation') + task.leaseGeneration
          : task.claimedUntil + t('tasks.copy.generation') + task.leaseGeneration;
        leaseCell.append(leaseLabel, leaseValue);
      }

      var msgsCell = document.createElement('div');
      msgsCell.className = 'cell task-msgs';
      var msgsLabel = document.createElement('span');
      msgsLabel.className = 'cell-label';
      msgsLabel.textContent = t('tasks.action.msgs');
      var msgsValue = document.createElement('span');
      msgsValue.textContent = String(Array.isArray(task.messages) ? task.messages.length : 0);
      msgsCell.append(msgsLabel, msgsValue);

      button.append(stateCell, peopleCell, subjectCell, updatedCell);
      if (leaseCell) button.append(leaseCell);
      button.append(msgsCell);
      button.addEventListener('click', function () {
        selectTask(task.id);
      });
      tasksRows.append(button);
    });
  }

  function fillTaskFromSelect(select, task) {
    select.replaceChildren();
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = t('tasks.action.chooseYourAddress');
    select.append(blank);
    [task.from, task.to].forEach(function (address) {
      if (!address) return;
      var option = document.createElement('option');
      option.value = address;
      option.textContent = address;
      select.append(option);
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
      err.textContent = state.taskDetailMessage || t('tasks.error.taskCouldNotBeLoaded');
      tasksDetailContent.append(err);
      return;
    }
    if (state.taskDetailStatus === 'loading' && !state.taskDetail) {
      tasksDetailContent.replaceChildren();
      var loading = document.createElement('p');
      loading.className = 'empty-state';
      loading.textContent = t('tasks.action.loadingTask');
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
    badge.setAttribute('data-state', taskStateToken(task));
    badge.textContent = taskStateLabel(task);
    var title = document.createElement('h3');
    title.textContent = task.subject || t('tasks.action.noSubject');
    var meta = document.createElement('p');
    meta.className = 'task-detail-meta';
    meta.textContent =
      (task.from || '—') +
      ' → ' +
      (task.to || '—') +
      t('tasks.copy.updated') +
      formatAgo(task.updatedAt) +
      ' · ' +
      (Array.isArray(task.messages) ? task.messages.length : 0) +
      t('tasks.copy.messages');
    head.append(title, badge, meta);
    var hasLeaseAuthority = typeof task.claimedUntil === 'string' && typeof task.leaseGeneration === 'number';
    var hasActiveLease = hasLeaseAuthority && task.leaseStatus !== 'disabled';
    var hasDisabledLeaseAuthority = hasLeaseAuthority && task.leaseStatus === 'disabled';
    if (hasActiveLease || hasDisabledLeaseAuthority) {
      var leaseMeta = document.createElement('p');
      leaseMeta.className = 'task-detail-meta';
      leaseMeta.textContent = hasDisabledLeaseAuthority
        ? t('tasks.copy.leaseDisabledRetainedAuthorityUntil') + task.claimedUntil + t('tasks.copy.generation') + task.leaseGeneration
        : t('tasks.copy.claimedUntil') + task.claimedUntil + t('tasks.copy.generation') + task.leaseGeneration;
      head.append(leaseMeta);
    }
    if (task.overdueReason) {
      var overdueNote = document.createElement('p');
      overdueNote.className = 'task-overdue-flag';
      overdueNote.textContent = task.overdueReason === 'submitted'
        ? t('tasks.copy.overdueSubmittedMoreThan4Hours')
        : t('tasks.copy.overdueWorkingMoreThan24Hours');
      head.append(overdueNote);
    }
    if (approvalPastDeadline(task)) {
      var expiryNote = document.createElement('p');
      expiryNote.className = 'task-expiry-flag';
      expiryNote.textContent = t('tasks.action.pastDeadlineThisApprovalHasExpired');
      head.append(expiryNote);
    }
    if (state.taskDetailStatus === 'loading') {
      var pending = document.createElement('p');
      pending.className = 'task-detail-meta';
      pending.textContent = t('tasks.action.refreshingTicketDetail');
      head.append(pending);
    }
    tasksDetailContent.append(head);

    var messages = Array.isArray(task.messages) ? task.messages : [];
    var original = messages[0];
    if (original && original.body) {
      var originalBlock = document.createElement('details');
      originalBlock.className = 'task-original';
      var originalSummary = document.createElement('summary');
      originalSummary.textContent = t('tasks.action.originalRequest');
      var originalBody = document.createElement('pre');
      originalBody.className = 'task-original-body';
      originalBody.textContent = taskTimelineBody(original.body);
      originalBlock.append(originalSummary, originalBody);
      tasksDetailContent.append(originalBlock);
    }

    var timelineTotal = messages.length;
    var timelineTruncated = timelineTotal > TASK_TIMELINE_RENDER_LIMIT;
    var visibleMessages = timelineTruncated
      ? messages.slice(timelineTotal - TASK_TIMELINE_RENDER_LIMIT)
      : messages;
    if (timelineTruncated) {
      var timelineNote = document.createElement('p');
      timelineNote.className = 'task-detail-meta';
      timelineNote.textContent =
        t('tasks.copy.showingLatest') + TASK_TIMELINE_RENDER_LIMIT + t('tasks.copy.of') + timelineTotal + t('tasks.copy.timelineEvents');
      tasksDetailContent.append(timelineNote);
    }
    var timeline = document.createElement('ol');
    timeline.className = 'task-timeline';
    visibleMessages.forEach(function (message) {
      var item = document.createElement('li');
      item.className = 'task-timeline-item';
      var metaRow = document.createElement('div');
      metaRow.className = 'task-timeline-meta';
      var msgBadge = document.createElement('span');
      msgBadge.className = 'task-badge';
      if (message.kind === 'reminder') {
        msgBadge.setAttribute('data-state', 'reminder');
        msgBadge.textContent = taskStateDisplay('reminder');
      } else {
        msgBadge.setAttribute('data-state', message.state || '');
        msgBadge.textContent = taskStateDisplay(message.state);
      }
      var from = document.createElement('span');
      from.className = 'task-timeline-from';
      from.textContent = message.from || '—';
      var when = document.createElement('time');
      when.className = 'task-timeline-time';
      when.dateTime = message.date || '';
      when.textContent = message.date ? formatDate(message.date) : '—';
      metaRow.append(msgBadge, from, when);
      var messageBlock = document.createElement('details');
      messageBlock.className = 'task-timeline-message';
      var messageSummary = document.createElement('summary');
      messageSummary.textContent = t('tasks.action.viewMessage');
      var body = document.createElement('pre');
      body.className = 'task-timeline-body';
      body.textContent = taskTimelineBody(message.body);
      messageBlock.append(messageSummary, body);
      item.append(metaRow, messageBlock);
      timeline.append(item);
    });
    tasksDetailContent.append(timeline);

    if (task.result !== undefined) {
      var resultBlock = document.createElement('details');
      resultBlock.className = 'task-result';
      resultBlock.open = true;
      var summary = document.createElement('summary');
      summary.textContent = taskIsClosed(task) ? t('tasks.action.closed') : t('tasks.action.result');
      resultBlock.append(summary, renderTaskResultNode(task.result));
      tasksDetailContent.append(resultBlock);
    }

    var approvalAction = task.kind === 'approval' ? renderApprovalAction(task) : null;
    if (approvalAction) tasksDetailContent.append(approvalAction);

    if (task.state === 'input-required' && task.kind !== 'approval') {
      var reply = document.createElement('form');
      reply.className = 'task-reply';
      var replyTitle = document.createElement('h4');
      replyTitle.textContent = t('tasks.action.reply');
      var replyHelp = document.createElement('p');
      replyHelp.className = 'muted';
      replyHelp.textContent = t('tasks.action.writeAReplyThisGoesBack');
      var replyBody = document.createElement('textarea');
      replyBody.rows = 4;
      replyBody.required = true;
      replyBody.maxLength = 3000;
      replyBody.setAttribute('aria-label', t('tasks.a11y.replyBody'));
      var replyFrom = null;
      if (isAdmin()) {
        replyFrom = document.createElement('select');
        replyFrom.className = 'search-input';
        replyFrom.setAttribute('aria-label', t('tasks.a11y.sendAs'));
        fillTaskFromSelect(replyFrom, task);
      }
      var replySubmit = document.createElement('button');
      replySubmit.type = 'submit';
      replySubmit.className = 'primary';
      replySubmit.textContent = t('tasks.action.sendReply');
      reply.append(replyTitle, replyHelp, replyBody);
      if (replyFrom) reply.append(replyFrom);
      reply.append(replySubmit);
      reply.addEventListener('submit', function (event) {
        event.preventDefault();
        submitTaskReply(task, replyBody.value, replyFrom ? replyFrom.value : '', replySubmit);
      });
      tasksDetailContent.append(reply);
    }

    if (isAdmin() && task.kind !== 'approval' && task.state !== 'completed' && task.state !== 'failed') {
      var admin = document.createElement('div');
      admin.className = 'task-admin-actions';
      var fromSelect = document.createElement('select');
      fromSelect.className = 'search-input';
      fromSelect.setAttribute('aria-label', t('tasks.a11y.actAs'));
      fillTaskFromSelect(fromSelect, task);
      var remindBtn = document.createElement('button');
      remindBtn.type = 'button';
      remindBtn.className = 'quiet';
      remindBtn.textContent = t('tasks.action.remind');
      remindBtn.addEventListener('click', function () {
        submitTaskRemind(task, fromSelect.value, remindBtn);
      });
      var reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.className = 'search-input';
      reasonInput.maxLength = 3000;
      reasonInput.placeholder = t('tasks.placeholder.closeReason');
      reasonInput.setAttribute('aria-label', t('tasks.placeholder.closeReason'));
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'quiet delete-action';
      closeBtn.textContent = t('tasks.action.close');
      closeBtn.addEventListener('click', function () {
        confirmCloseTask(task, fromSelect.value, reasonInput.value);
      });
      admin.append(fromSelect, remindBtn, reasonInput, closeBtn);
      tasksDetailContent.append(admin);
    }
  }

  /* list/board 只读投影：打开中的详情必须跟上匹配行，禁用决策且标签一致。 */
  function syncActiveTaskDetailFromList(rows) {
    var detail = state.taskDetail;
    if (!detail || !state.activeTaskId || detail.id !== state.activeTaskId) return;
    var row = null;
    (Array.isArray(rows) ? rows : []).some(function (task) {
      if (task && task.id === state.activeTaskId) {
        row = task;
        return true;
      }
      return false;
    });
    if (!row || !approvalPastDeadline(row) || approvalPastDeadline(detail)) return;
    state.taskDetail = Object.assign({}, detail, {
      expiryProjection: 'past-deadline-unmaterialized'
    });
  }

  /* 按 id 并集：旧行保留，同行以新值覆盖（轮询第 1 页替换时仍能 sync 第 2+ 页详情）。 */
  function unionTasksById(previous, incoming) {
    var byId = {};
    (Array.isArray(previous) ? previous : []).forEach(function (row) {
      if (row && row.id) byId[row.id] = row;
    });
    (Array.isArray(incoming) ? incoming : []).forEach(function (row) {
      if (row && row.id) byId[row.id] = row;
    });
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  function renderTasks() {
    renderTasksMeta();
    renderTaskRows();
    renderTaskDetail();
  }

  async function loadTasks(options) {
    /* 刷新列表不打断详情请求，避免 activeTask 卡在 loading。 */
    var opts = options || {};
    var more = !!opts.more;
    if (more && (!state.tasksNextCursor || state.tasksPending)) return;
    cancelTasksListLoad();
    var controller = new AbortController();
    tasksController = controller;
    if (opts.poll) trackDashboardPollRequest(controller);
    state.tasksPending = true;
    state.tasksMessage = '';
    /* F1：filter 一变 fetchKey 就变——立刻 loading，别等网络返回才撤掉假空态。 */
    if (!more && state.tasksFetchKey !== tasksFetchKey()) {
      state.tasks = [];
      state.tasksNextCursor = '';
      state.tasksStatus = 'loading';
    } else if (!more && state.tasks.length === 0) {
      state.tasksStatus = 'loading';
    }
    renderTasks();
    try {
      var params = [
        'status=' + encodeURIComponent(state.tasksFilter || 'input-required'),
        'period=' + encodeURIComponent(state.tasksPeriod || '30d'),
        'limit=' + encodeURIComponent(String(state.tasksLimit || 20))
      ];
      if (more && state.tasksNextCursor) {
        params.push('cursor=' + encodeURIComponent(state.tasksNextCursor));
      }
      var payload = await apiJson('/ui/api/tasks?' + params.join('&'), { signal: controller.signal });
      if (tasksController !== controller) return;
      var incoming = Array.isArray(payload.tasks) ? payload.tasks : [];
      /* 详情同步用的行集：more 用已加载并集；非 more（含轮询）用替换前旧∪新按 id，避免第 2+ 页详情丢投影。 */
      var syncRows;
      if (more) {
        var seen = {};
        state.tasks.forEach(function (row) { seen[row.id] = true; });
        incoming.forEach(function (row) {
          if (!seen[row.id]) state.tasks.push(row);
        });
        syncRows = state.tasks;
      } else {
        var previousTasks = Array.isArray(state.tasks) ? state.tasks : [];
        state.tasks = incoming;
        syncRows = unionTasksById(previousTasks, incoming);
      }
      syncActiveTaskDetailFromList(syncRows);
      state.tasksNextCursor = payload.nextCursor || '';
      state.tasksTotalApprox = typeof payload.totalApprox === 'number' ? payload.totalApprox : state.tasks.length;
      state.tasksUpdatedAt = Date.now();
      state.tasksFetchKey = tasksFetchKey();
      state.tasksStatus = 'ready';
      state.tasksMessage = '';
      renderTasks();
      if (!opts.poll) announce(state.tasks.length + t('tasks.announce.tasksLoaded'));
      if (state.activeTaskId) {
        var stillThere = state.tasks.some(function (task) {
          return task.id === state.activeTaskId;
        });
        if (!stillThere && !more && !opts.poll) clearTaskDetail();
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.tasks.length === 0) {
        state.tasksStatus = 'error';
        state.tasksMessage = t('tasks.error.tasksCouldNotBeLoadedTry');
        /* 对齐 fetchKey，避免 !keyMatches 把诚实错误盖成永远 Loading… */
        state.tasksFetchKey = tasksFetchKey();
      } else {
        state.tasksStatus = 'error';
        state.tasksMessage = t('tasks.error.refreshFailedShowingPreviousTasks');
      }
      renderTasks();
    } finally {
      releaseDashboardPollRequest(controller);
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
    if (state.scope === 'tasks') syncUrlFromScope(false);
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
    /* 移动端进详情时滚到顶，避免 preventScroll 保留列表滚动位。 */
    window.scrollTo(0, 0);
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
      announce(t('tasks.announce.openedTask') + (detail.subject || id));
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.activeTaskId !== id) return;
      state.taskDetail = null;
      state.taskDetailStatus = 'error';
      state.taskDetailMessage =
        error.status === 403
          ? t('tasks.copy.youAreNotAParticipantOn')
          : error.status === 404
            ? t('tasks.copy.taskNotFound')
            : t('tasks.error.taskCouldNotBeLoaded');
      renderTasks();
      announce(state.taskDetailMessage);
    } finally {
      if (taskDetailController === controller) taskDetailController = null;
    }
  }

  async function submitTaskReply(task, body, from, button) {
    var text = (body || '').trim();
    if (!text) return;
    if (isAdmin() && !from) {
      announce(t('tasks.announce.chooseWhichAddressToSendAs'));
      return;
    }
    button.disabled = true;
    try {
      var payload = { body: text };
      if (isAdmin()) payload.from = from;
      await apiJson('/ui/api/tasks/' + encodeURIComponent(task.id) + '/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      announce(t('tasks.announce.replySent'));
      await selectTask(task.id);
      loadTasks();
    } catch (error) {
      if (error.message === 'session_expired') return;
      announce(error.status === 409 ? t('tasks.announce.thisTaskIsNotWaitingFor') : t('tasks.announce.replyCouldNotBeSent'));
    } finally {
      button.disabled = false;
    }
  }

  async function submitTaskRemind(task, from, button) {
    if (!from) {
      announce(t('tasks.announce.chooseWhichAddressToSendAs'));
      return;
    }
    button.disabled = true;
    try {
      await apiJson('/ui/api/tasks/' + encodeURIComponent(task.id) + '/remind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: from,
          idempotencyKey: 'ui-' + Date.now() + '-' + Math.random().toString(16).slice(2)
        })
      });
      announce(t('tasks.announce.reminderSent'));
      await selectTask(task.id);
      loadTasks();
    } catch (error) {
      if (error.message === 'session_expired') return;
      if (error.status === 409) announce(t('tasks.announce.thisTaskIsAlreadyClosed'));
      else if (error.status === 429) announce(t('tasks.announce.waitAMomentBeforeSendingAnother'));
      else announce(t('tasks.announce.reminderCouldNotBeSent'));
    } finally {
      button.disabled = false;
    }
  }

  function confirmCloseTask(task, from, reason) {
    if (!from) {
      announce(t('tasks.announce.chooseWhichAddressToSendAs'));
      return;
    }
    var text = (reason || '').trim();
    if (!text) {
      announce(t('tasks.announce.enterACloseReason'));
      return;
    }
    var openedGen = beginModal();
    confirmModalTitle.textContent = t('tasks.modal.closeTask');
    confirmModalText.textContent =
      t('tasks.copy.close') + (task.subject || task.id) + t('tasks.copy.thisWritesAClosedEventAnd');
    confirmModalRisk.hidden = true;
    confirmModalConfirm.textContent = t('tasks.modal.closeTask');
    confirmModal.hidden = false;
    confirmModalConfirm.onclick = async function () {
      confirmModalConfirm.disabled = true;
      try {
        await apiJson('/ui/api/tasks/' + encodeURIComponent(task.id) + '/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: text, from: from })
        });
        if (openedGen !== modalGeneration) return;
        closeAllModals();
        announce(t('tasks.announce.taskClosed'));
        await selectTask(task.id);
        loadTasks();
      } catch (error) {
        if (openedGen !== modalGeneration) return;
        if (error.message !== 'session_expired') {
          announce(error.status === 409 ? t('tasks.announce.thisTaskIsAlreadyClosed') : t('tasks.announce.taskCouldNotBeClosed'));
        }
      } finally {
        /* 仅当前代际才复位；stale 请求不得复活新 dialog 的共享钮。 */
        if (openedGen === modalGeneration) confirmModalConfirm.disabled = false;
      }
    };
    confirmModalConfirm.focus();
  }

  function enterTasks(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    applyScope('tasks', { announce: opts.announce, skipUrl: opts.skipUrl, replaceUrl: opts.replaceUrl });
    renderTasks();
    focusTasksPanel();
    var age = state.tasksUpdatedAt ? Math.max(0, Date.now() - state.tasksUpdatedAt) : Infinity;
    var fresh =
      state.tasksStatus === 'ready' &&
      age < FRESH_MS &&
      state.tasksFetchKey === tasksFetchKey();
    var after = function () {
      if (opts.taskId) selectTask(opts.taskId);
    };
    if (fresh) {
      after();
      return;
    }
    loadTasks().then(after);
  }
