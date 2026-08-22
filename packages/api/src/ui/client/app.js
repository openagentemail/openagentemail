  async function waitForPreviousRefresh() {
    if (!refreshTask) return;
    try {
      await refreshTask;
    } catch {
      return;
    }
  }

  async function selectIdentity(address, options) {
    var opts = options || {};
    var folder = opts.folder || state.activeFolder || 'inbox';
    if (
      address === state.activeAddress &&
      folder === state.activeFolder &&
      state.messages.length &&
      !opts.force
    ) {
      if (!opts.skipMobile) {
        var nextView = opts.mobileView || 'list';
        var fromFolders = inboxView.dataset.mobileView === 'folders';
        inboxView.dataset.mobileView = nextView;
        /* 已选身份快路径也必须把 list 压进历史，否则 Back 会跳过 list 层。 */
        if (!opts.skipUrl && fromFolders && nextView === 'list' && window.innerWidth <= 820) {
          syncUrlFromScope(false);
        }
      }
      return;
    }
    if (detailController) {
      detailController.abort();
      detailController = null;
    }
    if (sourceController) {
      /* 身份切换时 abort 在途 Source，避免 A 的源码落到 B 的页面。 */
      sourceController.abort();
      sourceController = null;
    }
    if (refreshController) refreshController.abort();
    await waitForPreviousRefresh();
    state.activeAddress = address;
    state.activeFolder = folder;
    state.messages = [];
    state.nextCursor = '';
    state.sourceCache = null;
    clearDetail();
    renderIdentities();
    renderFolderNav();
    renderMessages();
    if (!opts.skipMobile) inboxView.dataset.mobileView = opts.mobileView || 'list';
    if (!opts.skipUrl) {
      var replace = opts.replaceUrl !== undefined ? opts.replaceUrl : window.innerWidth > 820;
      syncUrlFromScope(replace);
    }
    await refreshMessages();
  }

  async function refreshMessages(options) {
    var opts = options || {};
    if (!state.activeAddress) return;
    if (refreshTask && !opts.more) return;
    if (opts.more && (!state.nextCursor || refreshTask)) return;
    var requestedAddress = state.activeAddress;
    var requestedFolder = state.activeFolder || 'inbox';
    var controller = new AbortController();
    refreshController = controller;
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    if (!opts.more) messageState.textContent = 'Loading messages…';
    if (loadMoreMessages) loadMoreMessages.disabled = true;

    var url = requestedFolder === 'sent'
      ? '/ui/api/send-log?address=' + encodeURIComponent(requestedAddress) + '&limit=50'
      : '/ui/api/messages?address=' + encodeURIComponent(requestedAddress) +
        '&folder=' + encodeURIComponent(requestedFolder) +
        '&limit=50';
    if (opts.more && state.nextCursor) {
      url += '&cursor=' + encodeURIComponent(state.nextCursor);
    }

    var task = (async function () {
      var payload = await apiJson(url, { signal: controller.signal });
      if (state.activeAddress !== requestedAddress || state.activeFolder !== requestedFolder) return;
      var incoming = requestedFolder === 'sent'
        ? (Array.isArray(payload.items) ? payload.items : [])
        : (Array.isArray(payload.messages) ? payload.messages : []);
      if (opts.more) {
        var seen = {};
        state.messages.forEach(function (row) { seen[row.id] = true; });
        incoming.forEach(function (row) {
          if (!seen[row.id]) state.messages.push(row);
        });
      } else {
        state.messages = incoming;
      }
      state.nextCursor = payload.nextCursor || '';
      renderMessages();
      renderIdentities();
      renderFolderNav();
      announce(state.messages.length + ' messages loaded');
    })();
    refreshTask = task;
    try {
      await task;
    } catch (error) {
      if (error.name !== 'AbortError' && error.message !== 'session_expired') {
        messageState.textContent = 'Messages could not be loaded. Try Refresh.';
      }
    } finally {
      if (refreshTask === task) refreshTask = null;
      if (refreshController === controller) refreshController = null;
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh';
      if (loadMoreMessages) loadMoreMessages.disabled = !state.nextCursor;
    }
  }

  async function selectFolder(folder) {
    if (!state.activeAddress) return;
    await selectIdentity(state.activeAddress, {
      folder: folder,
      force: folder !== state.activeFolder,
      replaceUrl: window.innerWidth > 820,
      mobileView: 'list'
    });
  }

  function appendMeta(list, labelText, valueText) {
    var term = document.createElement('dt');
    term.textContent = labelText;
    var value = document.createElement('dd');
    value.textContent = valueText || '—';
    list.append(term, value);
  }

  function appendMetadataItem(list, labelText, valueText) {
    var item = document.createElement('div');
    item.className = 'metadata-item';
    appendMeta(item, labelText, valueText);
    list.append(item);
  }

  function selectForManualCopy(sourceNode) {
    var range = document.createRange();
    range.selectNodeContents(sourceNode);
    var selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString() === sourceNode.textContent;
  }

  async function copyValue(value, sourceNode, sourceButton) {
    try {
      await navigator.clipboard.writeText(value);
      announce('Copied to clipboard');
      /* 颜色不是唯一信号：播报先行，绿色只是附加确认。 */
      if (sourceButton) {
        sourceButton.classList.add('copied');
        window.setTimeout(function () {
          sourceButton.classList.remove('copied');
        }, 1200);
      }
    } catch {
      var selected = selectForManualCopy(sourceNode);
      announce(selected
        ? 'Clipboard unavailable. The value is selected for manual copying.'
        : 'Clipboard unavailable. Select the value and copy it manually.');
    }
  }

  function parsedHttpUrl(candidate) {
    try {
      var parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function linkRow(candidate) {
    var parsed = parsedHttpUrl(candidate);
    if (!parsed) return null;
    var row = document.createElement('div');
    row.className = 'link-row';
    var text = document.createElement('div');
    text.className = 'link-text';
    var host = document.createElement('span');
    host.className = 'link-host';
    host.textContent = parsed.hostname;
    var url = document.createElement('span');
    url.className = 'link-url';
    url.textContent = parsed.href;
    text.append(host, url);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'quiet link-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      copyValue(parsed.href, url, copy);
    });

    var open = document.createElement('a');
    open.className = 'open-link';
    open.textContent = 'Open';
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.referrerPolicy = 'no-referrer';
    open.href = parsed.href;
    row.append(text, copy, open);
    return row;
  }

  function appendLinks(parent, titleText, links) {
    var validRows = [];
    (Array.isArray(links) ? links : []).forEach(function (candidate) {
      var row = linkRow(candidate);
      if (row) validRows.push(row);
    });
    if (!validRows.length) return;
    var section = document.createElement('section');
    section.className = 'info-section';
    var title = document.createElement('h3');
    title.textContent = titleText;
    var warning = document.createElement('p');
    warning.className = 'sender-warning';
    warning.textContent = 'This link came from the sender. Check the domain before opening it.';
    var list = document.createElement('div');
    list.className = 'link-list';
    list.append.apply(list, validRows);
    section.append(title, warning, list);
    parent.append(section);
  }

  function appendOtp(parent, otp) {
    if (!otp) return;
    var codes = Array.isArray(otp.codes) ? otp.codes : [];
    if (codes.length) {
      var section = document.createElement('section');
      section.className = 'info-section';
      var title = document.createElement('h3');
      title.textContent = 'Verification codes';
      var list = document.createElement('div');
      list.className = 'code-list';
      codes.forEach(function (code) {
        var row = document.createElement('div');
        row.className = 'code-row';
        var value = document.createElement('code');
        value.className = 'code-value';
        value.textContent = code;
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'quiet';
        copy.textContent = 'Copy';
        copy.addEventListener('click', function () {
          copyValue(code, value, copy);
        });
        row.append(value, copy);
        list.append(row);
      });
      section.append(title, list);
      parent.append(section);
    }
    appendLinks(parent, 'Verification links', otp.links);
  }

  function renderPlainBody(container, detail) {
    container.replaceChildren();
    var plain = document.createElement('pre');
    plain.className = 'plain-body';
    plain.textContent = detail.text || 'This message has no plain-text body.';
    container.append(plain);
  }

  function renderHtmlBody(container, detail) {
    container.replaceChildren();
    var frame = document.createElement('iframe');
    frame.className = 'mail-frame';
    frame.title = 'Isolated HTML email preview';
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', '');
    frame.src = '/ui/frame/' + encodeURIComponent(detail.id) +
      '?address=' + encodeURIComponent(state.activeAddress);
    container.append(frame);
  }

  function renderSourceBody(container, payload) {
    container.replaceChildren();
    var pre = document.createElement('pre');
    pre.className = 'source-body';
    pre.appendChild(document.createTextNode(payload.source || ''));
    container.append(pre);
    if (payload.truncated) {
      var note = document.createElement('p');
      note.className = 'notice warning';
      note.textContent = 'Source truncated at the server size limit.';
      container.append(note);
    }
  }

  async function loadMessageSource(detail, container) {
    /* 请求时捕获 address：跨身份同 IMAP UID 的迟到响应不得写入 sourceCache。 */
    var requestedSourceAddress = state.activeAddress;
    if (
      state.sourceCache &&
      state.sourceCache.id === detail.id &&
      state.sourceCache.address === requestedSourceAddress
    ) {
      renderSourceBody(container, state.sourceCache);
      return;
    }
    if (sourceController) sourceController.abort();
    var controller = new AbortController();
    sourceController = controller;
    container.replaceChildren();
    var loading = document.createElement('p');
    loading.className = 'empty-state';
    loading.textContent = 'Loading source…';
    container.append(loading);
    try {
      var payload = await apiJson(
        '/ui/api/messages/' + encodeURIComponent(detail.id) +
          '/source?address=' + encodeURIComponent(requestedSourceAddress),
        { signal: controller.signal }
      );
      if (
        sourceController !== controller ||
        state.activeAddress !== requestedSourceAddress ||
        state.activeMessageId !== detail.id
      ) return;
      state.sourceCache = {
        id: payload.id,
        address: requestedSourceAddress,
        source: payload.source,
        truncated: payload.truncated,
        byteLength: payload.byteLength
      };
      renderSourceBody(container, state.sourceCache);
    } catch (error) {
      if (error.name !== 'AbortError' && error.message !== 'session_expired') {
        loading.textContent = 'Source could not be loaded.';
      }
    } finally {
      if (sourceController === controller) sourceController = null;
    }
  }

  function fillMetadata(drawer, detail, summary) {
    drawer.replaceChildren();
    var heading = document.createElement('h3');
    heading.textContent = 'Headers';
    var meta = document.createElement('dl');
    meta.className = summary ? 'meta metadata-summary' : 'meta';
    var append = summary ? appendMetadataItem : appendMeta;
    append(meta, 'From', detail.from);
    append(meta, 'To', detail.to);
    append(meta, 'Date', formatDate(detail.date));
    append(meta, 'Id', detail.id);
    append(meta, 'Source', detail.source === 'internal' ? 'internal' : 'external');
    drawer.append(heading, meta);
  }

  function renderDetail(detail) {
    detailContent.replaceChildren();
    state.bodyView = detail.hasHtml && !detail.htmlTooLarge ? 'rendered' : 'plain';

    var header = document.createElement('header');
    header.className = 'detail-header';
    var label = document.createElement('p');
    label.className = 'eyebrow';
    label.textContent = 'Message';
    var title = document.createElement('h2');
    title.textContent = detail.subject || '(no subject)';
    header.append(label, title);

    var summary = null;
    for (var mi = 0; mi < state.messages.length; mi++) {
      if (state.messages[mi].id === detail.id) { summary = state.messages[mi]; break; }
    }
    if (summary) {
      var seenToggle = document.createElement('button');
      seenToggle.type = 'button';
      seenToggle.className = 'quiet seen-toggle';
      seenToggle.textContent = summary.seen ? 'Mark as unread' : 'Mark as read';
      seenToggle.addEventListener('click', function () {
        toggleSeen(detail.id, summary, seenToggle);
      });
      header.append(seenToggle);
    }

    var otpHost = document.createElement('div');
    otpHost.className = 'detail-otp';
    appendOtp(otpHost, detail.otp);
    appendLinks(otpHost, 'Links in this message', detail.links);

    var tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.setAttribute('role', 'tablist');
    var renderedTab = document.createElement('button');
    renderedTab.type = 'button';
    renderedTab.className = 'tab';
    renderedTab.textContent = 'Rendered';
    renderedTab.setAttribute('role', 'tab');
    renderedTab.disabled = !detail.hasHtml || detail.htmlTooLarge;
    if (detail.htmlTooLarge) {
      renderedTab.title = 'This email is too large to preview safely.';
    }
    var plainTab = document.createElement('button');
    plainTab.type = 'button';
    plainTab.className = 'tab';
    plainTab.textContent = 'Plain text';
    plainTab.setAttribute('role', 'tab');
    var sourceTab = document.createElement('button');
    sourceTab.type = 'button';
    sourceTab.className = 'tab';
    sourceTab.textContent = 'Source';
    sourceTab.setAttribute('role', 'tab');
    var headersTab = document.createElement('button');
    headersTab.type = 'button';
    headersTab.className = 'tab tab-headers';
    headersTab.textContent = 'Headers';
    headersTab.setAttribute('role', 'tab');
    tabs.append(renderedTab, plainTab, sourceTab, headersTab);

    var body = document.createElement('section');
    body.className = 'detail-body-panel';
    body.setAttribute('role', 'tabpanel');

    function selectBodyView(name) {
      state.bodyView = name;
      renderedTab.setAttribute('aria-selected', name === 'rendered' ? 'true' : 'false');
      plainTab.setAttribute('aria-selected', name === 'plain' ? 'true' : 'false');
      sourceTab.setAttribute('aria-selected', name === 'source' ? 'true' : 'false');
      headersTab.setAttribute('aria-selected', name === 'headers' ? 'true' : 'false');
      if (name === 'headers') {
        fillMetadata(body, detail);
        return;
      }
      if (name === 'source') {
        loadMessageSource(detail, body);
        return;
      }
      if (name === 'rendered') renderHtmlBody(body, detail);
      else renderPlainBody(body, detail);
    }
    renderedTab.addEventListener('click', function () { selectBodyView('rendered'); });
    plainTab.addEventListener('click', function () { selectBodyView('plain'); });
    sourceTab.addEventListener('click', function () { selectBodyView('source'); });
    headersTab.addEventListener('click', function () { selectBodyView('headers'); });

    var mainCol = document.createElement('div');
    mainCol.className = 'detail-main-col';
    mainCol.append(otpHost, tabs);
    if (detail.htmlTooLarge) {
      var htmlUnavailable = document.createElement('p');
      htmlUnavailable.className = 'notice warning';
      htmlUnavailable.textContent =
        'This email is too large to preview safely. Use the plain-text view instead.';
      mainCol.append(htmlUnavailable);
    }
    mainCol.append(body);

    var drawer = document.createElement('section');
    drawer.className = 'metadata-drawer';
    drawer.setAttribute('aria-label', 'Message metadata');
    fillMetadata(drawer, detail, true);

    var layout = document.createElement('div');
    layout.className = 'detail-body-layout';
    layout.append(header, drawer, mainCol);
    detailContent.append(layout);
    selectBodyView(state.bodyView);
  }

  async function toggleSeen(id, summary, button) {
    button.disabled = true;
    try {
      await apiJson('/ui/api/messages/' + encodeURIComponent(id) + '/seen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: state.activeAddress, seen: !summary.seen })
      });
      summary.seen = !summary.seen;
      button.textContent = summary.seen ? 'Mark as unread' : 'Mark as read';
      renderMessages();
      announce(summary.seen ? 'Marked as read.' : 'Marked as unread.');
    } catch (error) {
      if (error.message !== 'session_expired') {
        announce('Could not update the message. Try again.');
      }
    } finally {
      button.disabled = false;
    }
  }


  /* Sent 详情：只展示审计行，不含正文。 */
  function renderSendLogDetail(row) {
    detailContent.replaceChildren();
    var heading = document.createElement('h2');
    heading.textContent = row.subject || '(no subject)';
    var meta = document.createElement('dl');
    meta.className = 'meta';
    appendMeta(meta, 'From', row.from);
    appendMeta(meta, 'To', Array.isArray(row.to) ? row.to.join(', ') : row.to);
    appendMeta(meta, 'Sent', row.sentAt);
    appendMeta(meta, 'Result', row.result === 'failed' ? ('Failed' + (row.error ? ' · ' + row.error : '')) : 'Queued');
    appendMeta(meta, 'Message-ID', row.messageId);
    appendMeta(meta, 'Source', row.source === 'mcp' ? 'MCP' : 'API');
    var badge = document.createElement('span');
    badge.className = 'send-result-badge';
    badge.setAttribute('data-result', row.result === 'failed' ? 'failed' : 'queued');
    badge.textContent = row.result === 'failed' ? 'Failed' : 'Queued';
    var note = document.createElement('p');
    note.className = 'send-log-note';
    note.textContent = 'API/MCP send audit (30 days). Direct SMTP is not listed. Body is not stored.';
    detailContent.append(heading, badge, meta, note);
  }

  async function selectMessage(id, options) {
    var opts = options || {};
    if (detailController) detailController.abort();
    if (sourceController) {
      sourceController.abort();
      sourceController = null;
    }
    var controller = new AbortController();
    var requestedDetailAddress = state.activeAddress;
    detailController = controller;
    state.activeMessageId = id;
    state.sourceCache = null;
    renderMessages();
    detailContent.replaceChildren();
    var loading = document.createElement('p');
    loading.className = 'empty-state';
    loading.textContent = 'Loading message…';
    detailContent.append(loading);
    if (!opts.skipPush && window.innerWidth <= 820) {
      history.pushState(
        { scope: 'inbox', mobileView: 'detail', messageId: id, folder: state.activeFolder || 'inbox' },
        '',
        window.location.pathname
      );
    }
    inboxView.dataset.mobileView = 'detail';
    try {
      var detail = state.activeFolder === 'sent'
        ? await apiJson('/ui/api/send-log/' + encodeURIComponent(id), { signal: controller.signal })
        : await apiJson(
            '/ui/api/messages/' + encodeURIComponent(id) +
              '?address=' + encodeURIComponent(requestedDetailAddress),
            { signal: controller.signal }
          );
      if (
        detailController !== controller ||
        state.activeAddress !== requestedDetailAddress
      ) return;
      state.detail = detail;
      if (state.activeFolder === 'sent') renderSendLogDetail(detail);
      else renderDetail(detail);
      detailPanel.focus();
    } catch (error) {
      if (error.name !== 'AbortError' && error.message !== 'session_expired') {
        loading.textContent = 'This message could not be loaded.';
      }
    } finally {
      if (detailController === controller) detailController = null;
    }
  }

  async function loadInbox() {
    var identityPayload = await apiJson('/ui/api/identities');
    state.identities = Array.isArray(identityPayload.identities) ? identityPayload.identities : [];
    state.activeAddress = state.identities[0] ? state.identities[0].address : '';
    if (!state.activeFolder) state.activeFolder = 'inbox';
    renderIdentities();
    renderFolderNav();
    renderMessages();
    if (state.scope === 'overview') renderOverview();
    clearDetail();
    if (state.activeAddress) await refreshMessages();
  }

  async function startSession() {
    configureSession();
    byId('session-label').textContent = state.me.kind === 'admin'
      ? 'Admin session'
      : state.me.address;
    /* Home/其它非 Mail 深链必须先落面：不能被首个邮箱的消息加载挡住。 */
    var route = parseLocationRoute();
    if (route.scope !== 'inbox') {
      await applyRoute(route, { replaceUrl: true, announce: '', seedMobileStack: true });
      await loadInbox();
      return;
    }
    await loadInbox();
    await applyRoute(route, { replaceUrl: true, announce: '', seedMobileStack: true });
  }

  loginForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!configureLoginGate()) return;
    loginError.textContent = '';
    loginSubmit.disabled = true;
    var credential = loginToken.value;
    loginToken.value = '';
    try {
      var response = await fetch('/ui/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: credential, remember: loginRemember.checked })
      });
      if (!response.ok) {
        loginError.textContent = response.status === 401
          ? 'That token is not valid.'
          : 'Sign-in is temporarily unavailable. Try again.';
        return;
      }
      var loginPayload = await response.json();
      state.me = loginPayload;
      /* 登录成功后若服务端带回 returnTo（OAuth 同意页），优先回跳。 */
      if (consumeReturnTo(loginPayload)) return;
      showInbox();
      await startSession();
    } catch {
      loginError.textContent = 'Could not reach the server.';
    } finally {
      loginSubmit.disabled = !isLoginContextSafe();
    }
  });

  byId('logout-button').addEventListener('click', async function () {
    try {
      await fetch('/ui/api/session', {
        method: 'DELETE',
        credentials: 'same-origin'
      });
    } finally {
      state.me = null;
      state.identities = [];
      state.messages = [];
      state.overview = null;
      state.overviewStatus = 'idle';
      /* showLogin → clearNotifyState：与 401 过期路径同一套清理。 */
      showLogin('');
    }
  });

  identitySearch.addEventListener('input', function () {
    state.identityFilter = identitySearch.value;
    renderIdentities();
  });
  mobileIdentity.addEventListener('change', function () {
    if (mobileIdentity.value) activateAddress(mobileIdentity.value);
  });
  refreshButton.addEventListener('click', function () {
    /* identity 会话只有一个地址、也没有 Overview 可回，所以只有 admin 需要这一步。 */
    if (isAdmin()) refreshInboxIdentities();
    refreshMessages();
  });
  overviewRefresh.addEventListener('click', function () {
    loadHome({ refresh: true });
  });
  notifyRefresh.addEventListener('click', function () {
    loadNotificationLog({ force: true });
  });
  notifyTopicFilter.addEventListener('change', function () {
    state.notifyFilter = notifyTopicFilter.value;
    /* 过滤切换会改变要请求的 topic 集合（All 扇出 vs 单路），重新拉取。 */
    loadNotificationLog();
  });
  if (notifyLevelFilter) notifyLevelFilter.addEventListener('change', function () {
    state.notifyLevelFilter = notifyLevelFilter.value;
    loadNotificationLog();
  });
  if (notifyLimitFilter) notifyLimitFilter.addEventListener('change', function () {
    var next = Number(notifyLimitFilter.value);
    state.notifyLimit = next === 50 || next === 100 ? next : 20;
    loadNotificationLog();
  });
  if (notifyFromInput) notifyFromInput.addEventListener('change', function () {
    state.notifyFrom = notifyFromInput.value;
    loadNotificationLog();
  });
  if (notifyToInput) notifyToInput.addEventListener('change', function () {
    state.notifyTo = notifyToInput.value;
    loadNotificationLog();
  });
  if (notifyVerify) notifyVerify.addEventListener('click', function () {
    handleNotifyVerify();
  });
  tasksRefresh.addEventListener('click', function () {
    /* 显式 Refresh：列表完成后，仅在详情视图（或桌面双栏）重拉详情，避免移动 Back 后被劫持。 */
    loadTasks().then(function () {
      if (state.scope !== 'tasks' || !state.activeTaskId) return;
      var onDetail = inboxView.dataset.mobileView === 'tasks-detail';
      var desktop = window.innerWidth > 820;
      if (!onDetail && !desktop) return;
      selectTask(state.activeTaskId);
    });
  });
  if (tasksStatusTabs) tasksStatusTabs.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== tasksStatusTabs && !(target.getAttribute && target.getAttribute('data-status'))) {
      target = target.parentNode;
    }
    if (!target || target === tasksStatusTabs) return;
    var next = target.getAttribute('data-status');
    if (!next || next === state.tasksFilter) return;
    state.tasksFilter = next;
    state.tasksNextCursor = '';
    clearTaskDetail();
    loadTasks();
  });
  if (tasksPeriodFilter) tasksPeriodFilter.addEventListener('change', function () {
    state.tasksPeriod = tasksPeriodFilter.value || '30d';
    state.tasksNextCursor = '';
    clearTaskDetail();
    loadTasks();
  });
  if (tasksLimitFilter) tasksLimitFilter.addEventListener('change', function () {
    var next = Number(tasksLimitFilter.value);
    state.tasksLimit = next === 50 || next === 100 ? next : 20;
    state.tasksNextCursor = '';
    clearTaskDetail();
    loadTasks();
  });
  tasksMobileBack.addEventListener('click', function () {
    inboxView.dataset.mobileView = 'tasks-list';
    var active = tasksRows.querySelector('[aria-current="true"]');
    if (active) active.focus();
    else focusTasksPanel();
  });
  createIdentityButton.addEventListener('click', showCreateModal);
  createModalSubmit.addEventListener('click', handleCreateSubmit);
  tokenCopyButton.addEventListener('click', function () {
    copyValue(tokenValue.textContent, tokenValue, tokenCopyButton);
  });
  tokenModalClose.addEventListener('click', closeAllModals);
  confirmModalCancel.addEventListener('click', function () {
    // closeAllModals consumes the pending cancel side-effect exactly once (F107).
    closeAllModals();
  });
  createModalCancel.addEventListener('click', closeAllModals);
  backToOverview.addEventListener('click', function () {
    enterOverview({ returnTo: state.returnAddress, announce: 'Back to Home' });
  });
  function handleInboxMobileBack() {
    history.back();
  }
  byId('mobile-back').addEventListener('click', handleInboxMobileBack);
  if (listMobileBack) listMobileBack.addEventListener('click', handleInboxMobileBack);


  navToggle.addEventListener('click', function () {
    if (inboxView.getAttribute('data-nav-open') === 'true') closeNavDrawer();
    else openNavDrawer();
  });
  navBackdrop.addEventListener('click', closeNavDrawer);
  appNav.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== appNav && !(target.getAttribute && target.getAttribute('data-nav'))) {
      target = target.parentNode;
    }
    if (!target || target === appNav) return;
    event.preventDefault();
    var key = target.getAttribute('data-nav');
    if (key === 'inbox') navigateTo('inbox');
    else if (key === 'overview') navigateTo('overview');
    else if (key === 'tasks') navigateTo('tasks');
    else if (key === 'notifications') navigateTo('notifications');
    else if (key === 'configure-identities') navigateTo('configure-identities');
    else if (key === 'configure-push') navigateTo('configure-push');
    else if (key === 'configure-clients') navigateTo('configure-clients');
    else if (key === 'configure-domains') navigateTo('configure-domains');
    else if (key === 'plan') navigateTo('plan');
  });
  window.addEventListener('popstate', function (event) {
    applyRoute(parseLocationRoute(), { announce: '', historyState: event.state, fromPop: true });
  });
  configureIdentitiesCreate.addEventListener('click', showCreateModal);
  configurePushIdentity.addEventListener('change', function () {
    state.configurePushAddress = configurePushIdentity.value;
    renderConfigurePush();
  });
  if (configurePushAdd) configurePushAdd.addEventListener('click', showDeviceAddModal);
  if (deviceAddCancel) deviceAddCancel.addEventListener('click', closeAllModals);
  if (deviceAddSubmit) deviceAddSubmit.addEventListener('click', handleDeviceAddSubmit);
  if (devicePairClose) devicePairClose.addEventListener('click', closeAllModals);
  if (devicePairCopy) devicePairCopy.addEventListener('click', function () {
    copyValue(devicePairPassword.textContent, devicePairPassword, devicePairCopy);
  });
  configureClientsRefresh.addEventListener('click', function () { loadConfigureClients(); });

  (async function start() {
    configureLoginGate();
    try {
      var response = await fetch('/ui/api/me', { credentials: 'same-origin' });
      if (response.status === 401) { showLogin(''); return; }
      if (!response.ok) throw new Error('request_failed');
      var mePayload = await response.json();
      state.me = mePayload;
      if (consumeReturnTo(mePayload)) return;
      showInbox();
      await startSession();
    } catch {
      showLogin('Could not reach the server.');
    }
  })();
