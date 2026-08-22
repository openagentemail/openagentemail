  function renderConfigureClients(grants) {
    configureClientsRows.replaceChildren();
    if (!grants.length) {
      configureClientsState.textContent = 'No connected apps.';
      return;
    }
    configureClientsState.textContent = '';
    grants.forEach(function (grant) {
      var row = document.createElement('div');
      row.className = 'client-row';
      var meta = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = grant.clientName || grant.clientId || 'Client';
      var detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent = (grant.address || '') + (grant.clientId ? ' · ' + grant.clientId : '');
      meta.append(title, detail);
      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'quiet';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', function () {
        var openedGen = beginModal();
        confirmModalTitle.textContent = 'Revoke client?';
        confirmModalText.textContent = 'This deletes the grant and invalidates its tokens immediately.';
        confirmModalRisk.hidden = true;
        confirmModalConfirm.textContent = 'Revoke';
        confirmModal.hidden = false;
        confirmModalConfirm.onclick = async function () {
          confirmModalConfirm.disabled = true;
          try {
            await apiJson('/ui/api/oauth/grants/' + encodeURIComponent(grant.id), { method: 'DELETE' });
            if (openedGen !== modalGeneration) return;
            closeAllModals();
            announce('Client revoked.');
            loadConfigureClients();
          } catch (error) {
            if (openedGen !== modalGeneration) return;
            if (error.message !== 'session_expired') {
              configureClientsNotice.hidden = false;
              configureClientsNotice.textContent = 'Could not revoke that client.';
            }
          } finally {
            /* 仅当前代际才复位；stale 请求不得复活新 dialog 的共享钮。 */
            if (openedGen === modalGeneration) confirmModalConfirm.disabled = false;
          }
        };
        confirmModalConfirm.focus();
      });
      row.append(meta, revoke);
      configureClientsRows.append(row);
    });
  }

  async function loadConfigureClients() {
    configureClientsNotice.hidden = true;
    configureClientsState.textContent = 'Loading…';
    try {
      var payload = await apiJson('/ui/api/oauth/grants');
      var grants = Array.isArray(payload.grants) ? payload.grants : [];
      configureClientsUpdated.textContent = 'Updated ' + formatClock(new Date().toISOString(), true);
      renderConfigureClients(grants);
    } catch (error) {
      if (error.message !== 'session_expired') {
        configureClientsState.textContent = 'Could not load connected apps.';
      }
    }
  }

  function enterConfigureClients(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('configure-clients', { announce: opts.announce });
    configureClientsPanel.focus({ preventScroll: true });
    loadConfigureClients();
  }
