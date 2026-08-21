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

  function tasksFetchKey() {
    return [
      state.tasksFilter || 'active',
      state.tasksPeriod || '30d',
      String(state.tasksLimit || 20)
    ].join('|');
  }

  function taskIsClosed(task) {
    return !!(task && task.result && task.result.closed_by_admin === true);
  }

  function taskStateLabel(task) {
    if (taskIsClosed(task)) return 'Closed';
    return task && task.state ? task.state : '—';
  }

  function taskStateToken(task) {
    if (taskIsClosed(task)) return 'closed';
    return task && task.state ? task.state : '';
  }

  function syncTasksFilters() {
    if (tasksStatusTabs) {
      var buttons = tasksStatusTabs.querySelectorAll('[data-status]');
      Array.prototype.forEach.call(buttons, function (button) {
        var selected = button.getAttribute('data-status') === (state.tasksFilter || 'active');
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    }
    if (tasksPeriodFilter) tasksPeriodFilter.value = state.tasksPeriod || '30d';
    if (tasksLimitFilter) tasksLimitFilter.value = String(state.tasksLimit || 20);
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

  function renderTaskRows() {
    tasksRows.replaceChildren();
    /* fetchKey 不匹配时旧缓存不可见，避免切筛选闪错位行。 */
    var keyMatches = state.tasksFetchKey === tasksFetchKey();
    var rows = keyMatches ? state.tasks : [];
    var awaiting = state.tasksStatus === 'loading' || !keyMatches;
    if (awaiting) {
      tasksShown.textContent = '';
      tasksStateNode.textContent = 'Loading…';
      return;
    }
    if (state.tasksStatus === 'error' && state.tasks.length === 0) {
      tasksShown.textContent = '';
      tasksStateNode.textContent = state.tasksMessage || 'Tasks could not be loaded. Try Refresh.';
      return;
    }
    var shown = rows.length;
    var total = typeof state.tasksTotalApprox === 'number' ? state.tasksTotalApprox : shown;
    tasksShown.textContent = shown === total ? String(shown) : shown + ' of ~' + total;
    if (rows.length === 0) {
      var filter = state.tasksFilter || 'active';
      tasksStateNode.textContent = filter === 'all'
        ? 'No tasks in this period. Refresh after a task mail arrives.'
        : 'No tasks in "' + filter + '" for this period.';
      return;
    }
    tasksStateNode.textContent = '';
    rows.forEach(function (task) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-row';
      if (task.overdueReason) button.classList.add('is-overdue');
      button.setAttribute('aria-current', task.id === state.activeTaskId ? 'true' : 'false');

      var stateCell = document.createElement('div');
      stateCell.className = 'cell';
      var stateLabel = document.createElement('span');
      stateLabel.className = 'cell-label';
      stateLabel.textContent = 'State';
      var badge = document.createElement('span');
      badge.className = 'task-badge';
      badge.setAttribute('data-state', taskStateToken(task));
      badge.textContent = taskStateLabel(task);
      stateCell.append(stateLabel, badge);
      if (task.overdueReason) {
        var overdue = document.createElement('span');
        overdue.className = 'task-overdue-flag';
        overdue.textContent = 'Overdue';
        stateCell.append(overdue);
      }

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

  function fillTaskFromSelect(select, task) {
    select.replaceChildren();
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Choose your address';
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
    badge.setAttribute('data-state', taskStateToken(task));
    badge.textContent = taskStateLabel(task);
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
    if (task.overdueReason) {
      var overdueNote = document.createElement('p');
      overdueNote.className = 'task-overdue-flag';
      overdueNote.textContent = task.overdueReason === 'submitted'
        ? 'Overdue: submitted more than 4 hours ago.'
        : 'Overdue: working more than 24 hours ago.';
      head.append(overdueNote);
    }
    if (state.taskDetailStatus === 'loading') {
      var pending = document.createElement('p');
      pending.className = 'task-detail-meta';
      pending.textContent = 'Refreshing ticket detail…';
      head.append(pending);
    }
    tasksDetailContent.append(head);

    var messages = Array.isArray(task.messages) ? task.messages : [];
    var original = messages[0];
    if (original && original.body) {
      var originalBlock = document.createElement('details');
      originalBlock.className = 'task-original';
      var originalSummary = document.createElement('summary');
      originalSummary.textContent = 'Original request';
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
        'Showing latest ' + TASK_TIMELINE_RENDER_LIMIT + ' of ' + timelineTotal + ' timeline events.';
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
        msgBadge.textContent = 'reminder';
      } else {
        msgBadge.setAttribute('data-state', message.state || '');
        msgBadge.textContent = message.state || '—';
      }
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
      body.textContent = taskTimelineBody(message.body);
      item.append(metaRow, body);
      timeline.append(item);
    });
    tasksDetailContent.append(timeline);

    if (task.result !== undefined) {
      var resultBlock = document.createElement('details');
      resultBlock.className = 'task-result';
      resultBlock.open = true;
      var summary = document.createElement('summary');
      summary.textContent = taskIsClosed(task) ? 'Closed' : 'Result';
      resultBlock.append(summary, renderTaskResultNode(task.result));
      tasksDetailContent.append(resultBlock);
    }

    if (task.state === 'input-required') {
      var reply = document.createElement('form');
      reply.className = 'task-reply';
      var replyTitle = document.createElement('h4');
      replyTitle.textContent = 'Reply';
      var replyHelp = document.createElement('p');
      replyHelp.className = 'muted';
      replyHelp.textContent = 'This writes a working event on the mail thread.';
      var replyBody = document.createElement('textarea');
      replyBody.rows = 4;
      replyBody.required = true;
      replyBody.maxLength = 3000;
      replyBody.setAttribute('aria-label', 'Reply body');
      var replyFrom = null;
      if (isAdmin()) {
        replyFrom = document.createElement('select');
        replyFrom.className = 'search-input';
        replyFrom.setAttribute('aria-label', 'Send as');
        fillTaskFromSelect(replyFrom, task);
      }
      var replySubmit = document.createElement('button');
      replySubmit.type = 'submit';
      replySubmit.className = 'primary';
      replySubmit.textContent = 'Send reply';
      reply.append(replyTitle, replyHelp, replyBody);
      if (replyFrom) reply.append(replyFrom);
      reply.append(replySubmit);
      reply.addEventListener('submit', function (event) {
        event.preventDefault();
        submitTaskReply(task, replyBody.value, replyFrom ? replyFrom.value : '', replySubmit);
      });
      tasksDetailContent.append(reply);
    }

    if (isAdmin() && task.state !== 'completed' && task.state !== 'failed') {
      var admin = document.createElement('div');
      admin.className = 'task-admin-actions';
      var fromSelect = document.createElement('select');
      fromSelect.className = 'search-input';
      fromSelect.setAttribute('aria-label', 'Act as');
      fillTaskFromSelect(fromSelect, task);
      var remindBtn = document.createElement('button');
      remindBtn.type = 'button';
      remindBtn.className = 'quiet';
      remindBtn.textContent = 'Remind';
      remindBtn.addEventListener('click', function () {
        submitTaskRemind(task, fromSelect.value, remindBtn);
      });
      var reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.className = 'search-input';
      reasonInput.maxLength = 3000;
      reasonInput.placeholder = 'Close reason';
      reasonInput.setAttribute('aria-label', 'Close reason');
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'quiet delete-action';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', function () {
        confirmCloseTask(task, fromSelect.value, reasonInput.value);
      });
      admin.append(fromSelect, remindBtn, reasonInput, closeBtn);
      tasksDetailContent.append(admin);
    }
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
        'status=' + encodeURIComponent(state.tasksFilter || 'active'),
        'period=' + encodeURIComponent(state.tasksPeriod || '30d'),
        'limit=' + encodeURIComponent(String(state.tasksLimit || 20))
      ];
      if (more && state.tasksNextCursor) {
        params.push('cursor=' + encodeURIComponent(state.tasksNextCursor));
      }
      var payload = await apiJson('/ui/api/tasks?' + params.join('&'), { signal: controller.signal });
      if (tasksController !== controller) return;
      var incoming = Array.isArray(payload.tasks) ? payload.tasks : [];
      if (more) {
        var seen = {};
        state.tasks.forEach(function (row) { seen[row.id] = true; });
        incoming.forEach(function (row) {
          if (!seen[row.id]) state.tasks.push(row);
        });
      } else {
        state.tasks = incoming;
      }
      state.tasksNextCursor = payload.nextCursor || '';
      state.tasksTotalApprox = typeof payload.totalApprox === 'number' ? payload.totalApprox : state.tasks.length;
      state.tasksUpdatedAt = Date.now();
      state.tasksFetchKey = tasksFetchKey();
      state.tasksStatus = 'ready';
      state.tasksMessage = '';
      renderTasks();
      announce(state.tasks.length + ' tasks loaded');
      if (state.activeTaskId) {
        var stillThere = state.tasks.some(function (task) {
          return task.id === state.activeTaskId;
        });
        if (!stillThere && !more) clearTaskDetail();
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'session_expired') return;
      if (state.tasks.length === 0) {
        state.tasksStatus = 'error';
        state.tasksMessage = 'Tasks could not be loaded. Try Refresh.';
        /* 对齐 fetchKey，避免 !keyMatches 把诚实错误盖成永远 Loading… */
        state.tasksFetchKey = tasksFetchKey();
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

  async function submitTaskReply(task, body, from, button) {
    var text = (body || '').trim();
    if (!text) return;
    if (isAdmin() && !from) {
      announce('Choose which address to send as.');
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
      announce('Reply sent.');
      await selectTask(task.id);
      loadTasks();
    } catch (error) {
      if (error.message === 'session_expired') return;
      announce(error.status === 409 ? 'This task is not waiting for input.' : 'Reply could not be sent.');
    } finally {
      button.disabled = false;
    }
  }

  async function submitTaskRemind(task, from, button) {
    if (!from) {
      announce('Choose which address to send as.');
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
      announce('Reminder sent.');
      await selectTask(task.id);
      loadTasks();
    } catch (error) {
      if (error.message === 'session_expired') return;
      if (error.status === 409) announce('This task is already closed.');
      else if (error.status === 429) announce('Wait a moment before sending another reminder.');
      else announce('Reminder could not be sent.');
    } finally {
      button.disabled = false;
    }
  }

  function confirmCloseTask(task, from, reason) {
    if (!from) {
      announce('Choose which address to send as.');
      return;
    }
    var text = (reason || '').trim();
    if (!text) {
      announce('Enter a close reason.');
      return;
    }
    var openedGen = beginModal();
    confirmModalTitle.textContent = 'Close task';
    confirmModalText.textContent =
      'Close "' + (task.subject || task.id) + '"? This writes a Closed event and cannot be undone.';
    confirmModalRisk.hidden = true;
    confirmModalConfirm.textContent = 'Close task';
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
        announce('Task closed.');
        await selectTask(task.id);
        loadTasks();
      } catch (error) {
        if (openedGen !== modalGeneration) return;
        if (error.message !== 'session_expired') {
          announce(error.status === 409 ? 'This task is already closed.' : 'Task could not be closed.');
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

