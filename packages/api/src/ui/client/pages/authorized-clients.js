  function renderConfigureClients(grants) {
    configureClientsRows.replaceChildren();
    if (!grants.length) {
      configureClientsState.textContent = t('clients.action.noConnectedApps');
      return;
    }
    configureClientsState.textContent = '';
    grants.forEach(function (grant) {
      var row = document.createElement('div');
      row.className = 'client-row';
      var meta = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = grant.clientName || grant.clientId || t('clients.action.client');
      var detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent = (grant.address || '') + (grant.clientId ? ' · ' + grant.clientId : '');
      meta.append(title, detail);
      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'quiet';
      revoke.textContent = t('clients.action.revoke');
      revoke.addEventListener('click', function () {
        var openedGen = beginModal();
        confirmModalTitle.textContent = t('clients.modal.revokeClient');
        confirmModalText.textContent = t('clients.modal.thisDeletesTheGrantAndInvalidates');
        confirmModalRisk.hidden = true;
        confirmModalConfirm.textContent = t('clients.action.revoke');
        confirmModal.hidden = false;
        confirmModalConfirm.onclick = async function () {
          confirmModalConfirm.disabled = true;
          try {
            await apiJson('/ui/api/oauth/grants/' + encodeURIComponent(grant.id), { method: 'DELETE' });
            if (openedGen !== modalGeneration) return;
            closeAllModals();
            announce(t('clients.announce.clientRevoked'));
            loadConfigureClients();
          } catch (error) {
            if (openedGen !== modalGeneration) return;
            if (error.message !== 'session_expired') {
              configureClientsNotice.hidden = false;
              configureClientsNotice.textContent = t('clients.error.couldNotRevokeThatClient');
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
    configureClientsState.textContent = t('tasks.action.loading');
    try {
      var payload = await apiJson('/ui/api/oauth/grants');
      var grants = Array.isArray(payload.grants) ? payload.grants : [];
      configureClientsUpdated.textContent = t('tasks.action.updated') + formatClock(new Date().toISOString(), true);
      renderConfigureClients(grants);
    } catch (error) {
      if (error.message !== 'session_expired') {
        configureClientsState.textContent = t('clients.error.couldNotLoadConnectedApps');
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
