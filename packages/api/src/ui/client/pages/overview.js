  /* ---- Home 值班台：只呈现服务端投影，不在浏览器合成任务状态或徽标。 ---- */
  var HOME_TASK_LIMIT = 20;
  var HOME_ACTIVE_PAGE_LIMIT = 100;
  var HOME_VISIBLE_ROWS = 5;
  var DASHBOARD_POLL_MS = 30000;
  var DASHBOARD_IDLE_POLL_MS = 120000;
  var DASHBOARD_IDLE_AFTER_MS = 120000;
  var dashboardPollTimer = null;
  var dashboardPollControllers = [];
  var dashboardLastInteractionAt = Date.now();

  function homeTaskUrl(status, cursor, limit) {
    return '/ui/api/tasks?status=' + encodeURIComponent(status) +
      '&period=30d&limit=' + encodeURIComponent(String(limit || HOME_TASK_LIMIT)) +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  }

  /* listBoard 的逾期标记是每一行的服务端投影，不是跨 tab 汇总。分页直到能填满
     Home 的五条可见位或列表结束，避免较旧的 overdue 行被 Active 首屏遮住。 */
  async function loadHomeActiveOverdue(signal) {
    var cursor = '';
    var overdue = [];
    do {
      var payload = await apiJson(
        homeTaskUrl('active', cursor, HOME_ACTIVE_PAGE_LIMIT),
        { signal: signal },
      );
      var board = payload || {};
      var tasks = Array.isArray(board.tasks) ? board.tasks : [];
      tasks.forEach(function (task) {
        if (task.overdueReason) overdue.push(task);
      });
      cursor = board.nextCursor || '';
    } while (cursor && overdue.length < HOME_VISIBLE_ROWS);
    return overdue;
  }

  function homeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : 'Unavailable';
  }

  function homeTaskButton(task) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-task-row';
    if (task.overdueReason) button.classList.add('is-overdue');
    var subject = document.createElement('span');
    subject.className = 'home-task-subject';
    subject.textContent = task.subject || '(no subject)';
    var meta = document.createElement('span');
    meta.className = 'home-task-meta';
    meta.textContent = taskStateLabel(task) + ' · ' + formatAgo(task.updatedAt);
    button.append(subject, meta);
    button.addEventListener('click', function () {
      navigateTo('tasks', { taskId: task.id });
    });
    return button;
  }

  function homeLinkButton(label, scope, extras) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet home-link';
    button.textContent = label;
    button.addEventListener('click', function () {
      navigateTo(scope, extras || {});
    });
    return button;
  }

  function homeSection(title, count) {
    var section = document.createElement('section');
    section.className = 'home-section';
    var heading = document.createElement('div');
    heading.className = 'home-section-heading';
    var label = document.createElement('h2');
    label.textContent = title;
    heading.append(label);
    if (typeof count === 'number') {
      var badge = document.createElement('span');
      badge.className = 'count home-count';
      /* totalApprox 是本次 query 的服务端计数；不可用数组长度代替。 */
      badge.textContent = String(count);
      heading.append(badge);
    }
    section.append(heading);
    return section;
  }

  function appendHomeEmpty(section, title, detail, actionLabel, actionScope) {
    var empty = document.createElement('div');
    empty.className = 'home-empty';
    var heading = document.createElement('h3');
    heading.textContent = title;
    var copy = document.createElement('p');
    copy.textContent = detail;
    empty.append(heading, copy);
    if (actionLabel && actionScope) empty.append(homeLinkButton(actionLabel, actionScope));
    section.append(empty);
  }

  function renderHomeWaiting(section) {
    var rows = Array.isArray(state.homeWaitingTasks) ? state.homeWaitingTasks : [];
    if (state.homeStatus === 'loading' && !rows.length) {
      appendHomeEmpty(section, 'Loading tasks', 'Checking the tasks that need your input.');
      return;
    }
    if (!rows.length) {
      appendHomeEmpty(section, 'Nothing needs you right now.', 'New requests that need your input will appear here.', 'Open Tasks', 'tasks');
      return;
    }
    var list = document.createElement('div');
    list.className = 'home-task-list';
    rows.slice(0, HOME_VISIBLE_ROWS).forEach(function (task) {
      list.append(homeTaskButton(task));
    });
    section.append(list, homeLinkButton('Open Tasks', 'tasks'));
  }

  function renderHomeStuck(section) {
    var overdue = Array.isArray(state.homeStuckTasks) ? state.homeStuckTasks : [];
    var hasFailures = typeof state.homeFailedUrgentCount === 'number' && state.homeFailedUrgentCount > 0;
    if (!overdue.length && !hasFailures) {
      appendHomeEmpty(section, 'Nothing is blocked.', 'Overdue tasks and failed urgent pushes will be listed here.');
      return;
    }
    if (overdue.length) {
      var taskList = document.createElement('div');
      taskList.className = 'home-task-list';
      overdue.slice(0, HOME_VISIBLE_ROWS).forEach(function (task) {
        taskList.append(homeTaskButton(task));
      });
      section.append(taskList);
    }
    if (hasFailures) {
      var failed = document.createElement('button');
      failed.type = 'button';
      failed.className = 'home-failed-push';
      failed.textContent = state.homeFailedUrgentCount +
        (state.homeFailedUrgentCount === 1 ? ' urgent push failed today' : ' urgent pushes failed today');
      failed.addEventListener('click', function () { navigateTo('notifications'); });
      section.append(failed);
    }
    section.append(homeLinkButton('Open Alerts', 'notifications'));
  }

  function healthCard(label, value, scope) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-health-card';
    var labelNode = document.createElement('span');
    labelNode.className = 'home-health-label';
    labelNode.textContent = label;
    var valueNode = document.createElement('strong');
    valueNode.textContent = value;
    button.append(labelNode, valueNode);
    button.addEventListener('click', function () { navigateTo(scope); });
    return button;
  }

  function renderHomeHealth(section) {
    var sentence = document.createElement('p');
    sentence.className = 'home-health-copy';
    sentence.textContent = 'A quick read on your addresses, unread mail, and urgent pushes today.';
    section.append(sentence);
    var grid = document.createElement('div');
    grid.className = 'home-health-grid';
    if (isAdmin()) {
      grid.append(healthCard('Addresses', String(state.identities.length), 'configure-identities'));
      grid.append(healthCard('Unread mail', homeNumber(state.homeUnseenCount), 'inbox'));
    } else {
      grid.append(healthCard('Mail', 'Open mailbox', 'inbox'));
    }
    grid.append(healthCard('Urgent pushes today', homeNumber(state.homeUrgentSentCount), 'notifications'));
    section.append(grid);
  }

  function renderHomeSessionEmpty(host) {
    var noWaiting = state.homeWaitingTotal === 0;
    var noStuck = !state.homeStuckTasks.length && state.homeFailedUrgentCount === 0;
    if (!noWaiting || !noStuck) return;
    var section = document.createElement('section');
    section.className = 'home-session-empty';
    if (isAdmin() && state.identities.length === 0) {
      appendHomeEmpty(
        section,
        'No addresses yet.',
        'Create an address to start receiving mail and task updates.',
        'Open Identities',
        'configure-identities',
      );
    } else if (!isAdmin()) {
      appendHomeEmpty(
        section,
        'Your desk is clear.',
        'Open Mail to check your address or return when an agent needs you.',
        'Open Mail',
        'inbox',
      );
    }
    if (section.childNodes.length) host.append(section);
  }

  function renderOverview() {
    overviewPanel.classList.add('home-panel');
    overviewSubtitle.hidden = false;
    overviewSubtitle.textContent = 'What needs your attention today.';
    overviewOverlap.hidden = true;
    overviewDisclosure.hidden = true;
    overviewControls.hidden = true;
    overviewSort.hidden = true;
    overviewHeader.hidden = true;
    overviewRows.hidden = true;
    overviewRows.replaceChildren();
    overviewStateNode.hidden = true;
    overviewStateNode.textContent = '';
    createIdentityButton.hidden = true;
    overviewRefresh.hidden = false;
    overviewRefresh.disabled = state.homeStatus === 'loading';
    overviewRefresh.textContent = state.homeStatus === 'loading' ? 'Refreshing…' : 'Refresh';
    overviewUpdated.textContent = state.homeUpdatedAt
      ? 'Updated ' + formatClock(new Date(state.homeUpdatedAt).toISOString(), true)
      : '';
    overviewNotice.hidden = !state.homeMessage;
    overviewNotice.textContent = state.homeMessage;

    overviewStats.hidden = false;
    overviewStats.className = 'overview-stats home-dashboard';
    overviewStats.replaceChildren();
    var waiting = homeSection('Waiting for you', state.homeWaitingTotal);
    renderHomeWaiting(waiting);
    var stuck = homeSection('Blocked');
    renderHomeStuck(stuck);
    var health = homeSection('Health');
    renderHomeHealth(health);
    overviewStats.append(waiting, stuck, health);
    renderHomeSessionEmpty(overviewStats);
  }

  function homeResult(promise) {
    return promise.then(
      function (payload) { return { ok: true, payload: payload }; },
      function (error) { return { ok: false, error: error }; },
    );
  }

  function homeTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_err) {
      return 'UTC';
    }
  }

  async function loadHome(options) {
    var opts = options || {};
    if (!state.me) return;
    if (overviewController) overviewController.abort();
    var controller = new AbortController();
    overviewController = controller;
    if (opts.poll) trackDashboardPollRequest(controller);
    if (!opts.poll) state.homeStatus = 'loading';
    state.homeMessage = '';
    if (state.scope === 'overview') renderOverview();

    var signal = controller.signal;
    var waiting = homeResult(apiJson(homeTaskUrl('input-required'), { signal: signal }));
    var active = homeResult(loadHomeActiveOverdue(signal));
    var summary = homeResult(apiJson(
      '/ui/api/notify/summary?date=today&tz=' + encodeURIComponent(homeTimeZone()),
      { signal: signal },
    ));
    /* Overview 的全局未读仅管理员首屏读取；identity 永不触碰会返回 403 的接口。
       它不是轮询的一部分，N1 的周期请求只走 listBoard + notify/n。 */
    var unread = isAdmin() && !opts.poll
      ? homeResult(apiJson('/ui/api/overview', { signal: signal }))
      : Promise.resolve(null);
    var results = await Promise.all([waiting, active, summary, unread]);
    if (overviewController !== controller || signal.aborted) {
      if (overviewController === controller) overviewController = null;
      releaseDashboardPollRequest(controller);
      return;
    }
    overviewController = null;
    var issues = [];
    if (results[0] && results[0].ok) {
      var waitingPayload = results[0].payload || {};
      state.homeWaitingTasks = Array.isArray(waitingPayload.tasks) ? waitingPayload.tasks : [];
      state.homeWaitingTotal = typeof waitingPayload.totalApprox === 'number'
        ? waitingPayload.totalApprox
        : 0;
    } else if (results[0] && results[0].error.message !== 'session_expired') {
      issues.push('Tasks that need you could not be loaded.');
    }
    if (results[1] && results[1].ok) {
      state.homeStuckTasks = Array.isArray(results[1].payload) ? results[1].payload : [];
    } else if (results[1] && results[1].error.message !== 'session_expired') {
      issues.push('Blocked tasks could not be loaded.');
    }
    if (results[2] && results[2].ok) {
      var summaryPayload = results[2].payload || {};
      state.homeUrgentSentCount = typeof summaryPayload.ringCount === 'number'
        ? summaryPayload.ringCount
        : null;
      state.homeFailedUrgentCount = typeof summaryPayload.failedUrgentCount === 'number'
        ? summaryPayload.failedUrgentCount
        : 0;
    } else if (results[2] && results[2].error.message !== 'session_expired') {
      state.homeUrgentSentCount = null;
      issues.push('Today’s push summary is unavailable.');
    }
    if (results[3]) {
      if (results[3].ok) {
        var overviewPayload = results[3].payload || {};
        state.homeUnseenCount = overviewPayload.totals &&
          typeof overviewPayload.totals.unseenInWindow === 'number'
          ? overviewPayload.totals.unseenInWindow
          : null;
      } else if (results[3].error.message !== 'session_expired') {
        state.homeUnseenCount = null;
        issues.push('Unread mail count is unavailable.');
      }
    }
    state.homeStatus = issues.length ? 'error' : 'ready';
    state.homeMessage = issues.join(' ');
    state.homeUpdatedAt = Date.now();
    releaseDashboardPollRequest(controller);
    if (state.scope === 'overview') renderOverview();
  }

  function stopDashboardPolling() {
    if (dashboardPollTimer !== null) {
      window.clearTimeout(dashboardPollTimer);
      dashboardPollTimer = null;
    }
  }

  function trackDashboardPollRequest(controller) {
    dashboardPollControllers.push(controller);
  }

  function releaseDashboardPollRequest(controller) {
    dashboardPollControllers = dashboardPollControllers.filter(function (candidate) {
      return candidate !== controller;
    });
  }

  function abortDashboardPollRequests() {
    var pending = dashboardPollControllers.slice();
    dashboardPollControllers = [];
    pending.forEach(function (controller) { controller.abort(); });
  }

  function dashboardPollAllowed() {
    return Boolean(state.me) && !document.hidden &&
      (state.scope === 'overview' || state.scope === 'tasks' || state.scope === 'notifications');
  }

  function scheduleDashboardPolling() {
    stopDashboardPolling();
    if (!dashboardPollAllowed()) return;
    var idle = Date.now() - dashboardLastInteractionAt >= DASHBOARD_IDLE_AFTER_MS;
    dashboardPollTimer = window.setTimeout(function () {
      dashboardPollTimer = null;
      if (!dashboardPollAllowed()) return;
      var work = Promise.resolve();
      if (state.scope === 'overview') work = loadHome({ poll: true });
      else if (state.scope === 'tasks' && !state.tasksPending) work = loadTasks({ poll: true });
      else if (state.scope === 'notifications' && !state.notifyPending) work = loadNotificationLog({ poll: true });
      work.then(scheduleDashboardPolling, scheduleDashboardPolling);
    }, idle ? DASHBOARD_IDLE_POLL_MS : DASHBOARD_POLL_MS);
  }

  function noteDashboardInteraction() {
    dashboardLastInteractionAt = Date.now();
    if (dashboardPollTimer === null) scheduleDashboardPolling();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopDashboardPolling();
      abortDashboardPollRequests();
    }
    else scheduleDashboardPolling();
  });
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
    document.addEventListener(type, noteDashboardInteraction, { passive: true });
  });

  function cancelOverview() {
    if (overviewController) {
      overviewController.abort();
      overviewController = null;
    }
    stopDashboardPolling();
  }

  function refreshInboxIdentities() {
    return apiJson('/ui/api/identities').then(function (payload) {
      state.identities = Array.isArray(payload.identities) ? payload.identities : [];
      renderIdentities();
      reconcileActiveAddress();
      if (state.scope === 'overview') renderOverview();
    }).catch(function () {
      /* Inbox keeps its last known roster when a background refresh fails. */
    });
  }

  function reconcileActiveAddress() {
    if (!state.activeAddress) return;
    var exists = state.identities.some(function (identity) {
      return identity.address === state.activeAddress;
    });
    if (exists) return;
    var lost = state.activeAddress;
    state.activeAddress = '';
    state.messages = [];
    state.nextCursor = '';
    state.sourceCache = null;
    clearDetail();
    renderMessages();
    if (state.scope === 'inbox') enterOverview({ announce: lost + ' is no longer available. Back to Home.' });
  }

  function focusOverviewPanel() {
    overviewPanel.focus({ preventScroll: true });
  }

  function enterOverview(options) {
    var opts = options || {};
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('overview', { announce: opts.announce, skipUrl: opts.skipUrl, replaceUrl: opts.replaceUrl });
    renderOverview();
    focusOverviewPanel();
    var fresh = state.homeUpdatedAt && Date.now() - state.homeUpdatedAt < FRESH_MS;
    if (!fresh) loadHome({ refresh: false });
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
