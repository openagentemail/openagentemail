  var MAIL_FOLDER_ITEMS = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'sent', label: 'Sent' },
    { id: 'all', label: 'All Mail' }
  ];

  function renderFolderNav() {
    if (!folderList) return;
    folderList.replaceChildren();
    MAIL_FOLDER_ITEMS.forEach(function (item) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folder-button';
      btn.setAttribute('data-folder', item.id);
      btn.setAttribute('aria-current', (state.activeFolder || 'inbox') === item.id ? 'true' : 'false');
      btn.textContent = item.label;
      btn.addEventListener('click', function () {
        selectFolder(item.id);
      });
      li.append(btn);
      folderList.append(li);
    });
  }

  function renderMessages() {
    messageList.replaceChildren();
    activeAddress.textContent = state.activeAddress;
    var folderLabel = 'Inbox';
    if (state.activeFolder === 'sent') folderLabel = 'Sent';
    if (state.activeFolder === 'all') folderLabel = 'All Mail';
    messagesTitle.textContent = folderLabel;
    if (!state.activeAddress) {
      renderEmptyState(messageState, {
        title: 'Choose an address',
        purpose: 'Mail lists messages for one identity at a time. Pick an address in the left column, then open Inbox, Sent, or All Mail.',
        actionLabel: isAdmin() ? 'Create identity' : 'Refresh addresses',
        onAction: function () {
          if (isAdmin()) showCreateModal();
          else refreshInboxIdentities();
        }
      });
      if (loadMoreMessages) loadMoreMessages.hidden = true;
      return;
    }
    if (state.messages.length === 0) {
      renderEmptyState(messageState, state.activeFolder === 'sent'
        ? {
            title: 'No API/MCP sends in 30 days',
            purpose: 'Sent lists audit records of API/MCP sends (30 days). Direct SMTP is not listed. Refresh after mail_send or POST /v1/send.',
            actionLabel: 'Refresh',
            onAction: function () { refreshMessages(); }
          }
        : {
            title: 'No messages in ' + folderLabel,
            purpose: 'This folder only shows mail the server can match for ' + state.activeAddress + '. Refresh after new mail arrives, or switch folder.',
            actionLabel: 'Refresh',
            onAction: function () { refreshMessages(); }
          });
      if (loadMoreMessages) loadMoreMessages.hidden = true;
      return;
    }
    messageState.replaceChildren();
    /* Sent 诚实口径：只覆盖 API/MCP，不含 SMTP 直发。 */
    if (state.activeFolder === 'sent') {
      var note = document.createElement('p');
      note.className = 'send-log-note';
      note.textContent = 'API/MCP send audit (30 days). Direct SMTP is not listed.';
      messageState.append(note);
    }

    state.messages.forEach(function (message) {
      var item = document.createElement('li');
      item.className = 'message-item';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-button';
      button.setAttribute('aria-current', message.id === state.activeMessageId ? 'true' : 'false');

      var line = document.createElement('div');
      line.className = 'message-line';
      var from = document.createElement('span');
      from.className = 'message-from';
      from.textContent = message.from || 'Unknown sender';
      var date = document.createElement('time');
      date.className = 'message-date';
      date.dateTime = message.date || message.sentAt || '';
      date.textContent = formatDate(message.date || message.sentAt);
      line.append(from, date);

      var subject = document.createElement('div');
      subject.className = 'message-subject';
      subject.textContent = message.subject || '(no subject)';
      var snippet = document.createElement('p');
      snippet.className = 'message-snippet';
      if (state.activeFolder === 'sent') {
        var toList = Array.isArray(message.to) ? message.to.join(', ') : (message.to || '—');
        snippet.textContent = toList;
        var badge = document.createElement('span');
        badge.className = 'send-result-badge';
        badge.setAttribute('data-result', message.result === 'failed' ? 'failed' : 'queued');
        badge.textContent = message.result === 'failed' ? 'Failed' : 'Queued';
        button.append(line, subject, snippet, badge);
      } else {
        snippet.textContent = message.snippet || 'No preview';
        button.append(line, subject, snippet);
      }
      if (message.hasOtp) {
        var badge = document.createElement('span');
        badge.className = 'otp-badge';
        badge.textContent = 'CODE / ACTION';
        button.append(badge);
      }
      button.addEventListener('click', function () {
        selectMessage(message.id);
      });
      item.append(button);
      messageList.append(item);
    });
    renderLoadMore(loadMoreMessages, Boolean(state.nextCursor), function () {
      refreshMessages({ more: true });
    });
  }

  /* ---- Overview 渲染 ---- */
  function statsRow(address) {
    var payload = state.overview;
    if (!payload || !Array.isArray(payload.addresses)) return null;
    for (var index = 0; index < payload.addresses.length; index += 1) {
      if (payload.addresses[index].address === address) return payload.addresses[index];
    }
    return null;
  }

  function countParts(row, key) {
    /* 数值的诚实呈现：截断影响到该行时只给下界，下界为 0 时说 Unknown。 */
    if (!row) return { text: state.overviewStatus === 'loading' || state.overviewStatus === 'idle' ? 'Loading…' : 'Unavailable', flat: true };
    var value = row[key];
    if (row.complete) return { text: formatNumber(value), unit: key === 'unseen' ? 'unseen' : 'msgs', flat: value === 0 };
    if (value > 0) {
      return {
        text: '≥' + formatNumber(value),
        unit: key === 'unseen' ? 'unseen' : 'msgs',
        title: 'Lower bound — this scan hit its recipient limit.'
      };
    }
    return { text: 'Unknown', flat: true, title: 'Not counted — this scan hit its recipient limit.' };
  }

  /* 聚合卡片与行级共用同一套界向口径：totals.exact===false 时 IN WINDOW /
     UNSEEN / ACTIVE 24H 都是下界，下界为 0 就只能说 Unknown。 */
  function boundParts(value, exact) {
    if (exact) return { text: formatNumber(value) };
    if (value > 0) {
      return {
        text: '≥' + formatNumber(value),
        title: 'Lower bound — this scan hit its recipient limit.'
      };
    }
    return { text: 'Unknown', title: 'Not counted — this scan hit its recipient limit.' };
  }

  function appendCell(parent, labelText, parts, extra) {
    var cell = document.createElement('span');
    cell.className = 'cell';
    var label = document.createElement('span');
    label.className = 'cell-label';
    label.textContent = labelText;
    var value = document.createElement('span');
    value.className = 'cell-value' + (parts.flat ? ' row-flat' : '');
    if (extra) value.append(extra);
    value.append(document.createTextNode(parts.text));
    if (parts.title) value.title = parts.title;
    cell.append(label, value);
    if (parts.unit) {
      var unit = document.createElement('span');
      unit.className = 'cell-unit';
      unit.textContent = parts.unit;
      cell.append(unit);
    }
    parent.append(cell);
    return parts.text + (parts.unit ? ' ' + parts.unit : '');
  }

  function isActiveRow(row) {
    if (!row || !row.lastReceivedAt || !state.overview || !state.overview.totals) return false;
    var since = Date.parse(state.overview.totals.recentSince);
    return !Number.isNaN(since) && Date.parse(row.lastReceivedAt) >= since;
  }
