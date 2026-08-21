  /* ---- History API 路由（ADR #26：真 /ui/* 子路径） ---- */
  /* 畸形百分号编码（截断序列等）decode 会抛 URIError——捕获后当未知路径，避免启动白屏。 */
  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (_err) {
      return null;
    }
  }

  function parseLocationRoute() {
    var path = window.location.pathname || '/ui';
    if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
    if (path === '/ui') return { scope: 'overview', taskId: '', address: '', folder: '' };
    // 已载入 shell 的旧 History API 条目不经过服务端 301，也须归一化为 Home。
    if (path === '/ui/overview') return { scope: 'overview', taskId: '', address: '', folder: '' };
    if (path === '/ui/inbox') return { scope: 'inbox', taskId: '', address: '', folder: '' };
    if (path === '/ui/notifications') return { scope: 'notifications', taskId: '', address: '', folder: '' };
    if (path === '/ui/tasks') return { scope: 'tasks', taskId: '', address: '', folder: '' };
    if (path.indexOf('/ui/tasks/') === 0) {
      var taskId = safeDecodeURIComponent(path.slice('/ui/tasks/'.length));
      if (taskId === null) return { scope: 'inbox', taskId: '', address: '', folder: '', unknown: true };
      return { scope: 'tasks', taskId: taskId, address: '', folder: '' };
    }
    if (path.indexOf('/ui/inbox/') === 0) {
      var rest = path.slice('/ui/inbox/'.length).split('/');
      var address = rest[0] ? safeDecodeURIComponent(rest[0]) : '';
      var folder = rest[1] ? safeDecodeURIComponent(rest[1]) : '';
      if (address === null || folder === null) {
        return { scope: 'inbox', taskId: '', address: '', folder: '', unknown: true };
      }
      if (folder && folder !== 'inbox' && folder !== 'sent' && folder !== 'all') {
        folder = 'inbox';
      }
      return {
        scope: 'inbox',
        taskId: '',
        address: address,
        folder: folder
      };
    }
    if (path === '/ui/configure/identities') return { scope: 'configure-identities', taskId: '', address: '', folder: '' };
    if (path === '/ui/configure/push') return { scope: 'configure-push', taskId: '', address: '', folder: '' };
    if (path === '/ui/configure/clients') return { scope: 'configure-clients', taskId: '', address: '', folder: '' };
    if (path === '/ui/configure/domains') return { scope: 'configure-domains', taskId: '', address: '', folder: '' };
    if (path === '/ui/plan') return { scope: 'plan', taskId: '', address: '', folder: '' };
    return { scope: 'inbox', taskId: '', address: '', folder: '', unknown: true };
  }

  function pathForScope(scope, extras) {
    var extra = extras || {};
    if (scope === 'overview') return '/ui';
    if (scope === 'notifications') return '/ui/notifications';
    if (scope === 'tasks') {
      return extra.taskId ? '/ui/tasks/' + encodeURIComponent(extra.taskId) : '/ui/tasks';
    }
    if (scope === 'configure-identities') return '/ui/configure/identities';
    if (scope === 'configure-push') return '/ui/configure/push';
    if (scope === 'configure-clients') return '/ui/configure/clients';
    if (scope === 'configure-domains') return '/ui/configure/domains';
    if (scope === 'plan') return '/ui/plan';
    if (scope === 'inbox' && extra.address) {
      var folder = extra.folder || 'inbox';
      return '/ui/inbox/' + encodeURIComponent(extra.address) + '/' + encodeURIComponent(folder);
    }
    return '/ui/inbox';
  }

  function inboxHistoryState(mobileView) {
    return {
      scope: state.scope,
      mobileView: mobileView || inboxView.dataset.mobileView || 'list',
      folder: state.activeFolder || 'inbox'
    };
  }

  function syncUrlFromScope(replace) {
    var inboxOnFolders = state.scope === 'inbox' && inboxView.dataset.mobileView === 'folders';
    var path = pathForScope(state.scope, {
      taskId: state.scope === 'tasks' ? state.activeTaskId : '',
      address: state.scope === 'inbox' && !inboxOnFolders ? state.activeAddress : '',
      folder: state.activeFolder || 'inbox'
    });
    var current = window.location.pathname;
    if (current.length > 1 && current.charAt(current.length - 1) === '/') {
      current = current.slice(0, -1);
    }
    var hist = inboxHistoryState();
    if (current === path) {
      if (replace) history.replaceState(hist, '', path);
      return;
    }
    if (replace) history.replaceState(hist, '', path);
    else history.pushState(hist, '', path);
  }

  async function applyRoute(route, options) {
    var opts = options || {};
    closeNavDrawer();
    closeAllModals();
    if (route.scope === 'overview') {
      enterOverview({ announce: opts.announce, skipUrl: true });
      syncUrlFromScope(true);
      return;
    }
    if (route.scope === 'notifications') {
      enterNotifications({ announce: opts.announce, skipUrl: true });
      syncUrlFromScope(true);
      return;
    }
    if (route.scope === 'tasks') {
      enterTasks({ announce: opts.announce, skipUrl: true, taskId: route.taskId });
      syncUrlFromScope(true);
      return;
    }
    if (route.scope === 'configure-identities') {
      enterConfigureIdentities({ announce: opts.announce });
      return;
    }
    if (route.scope === 'configure-push') {
      enterConfigurePush({ announce: opts.announce });
      return;
    }
    if (route.scope === 'configure-clients') {
      enterConfigureClients({ announce: opts.announce });
      return;
    }
    if (route.scope === 'configure-domains') {
      enterConfigureDomains({ announce: opts.announce });
      return;
    }
    if (route.scope === 'plan') {
      enterPlan({ announce: opts.announce });
      return;
    }
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('inbox', { announce: opts.announce, skipUrl: true, replaceUrl: true });
    var hist = opts.historyState;
    if (hist === undefined) hist = window.history.state;
    var folder = route.folder || (hist && hist.folder) || state.activeFolder || 'inbox';
    if (folder !== 'inbox' && folder !== 'sent' && folder !== 'all') folder = 'inbox';
    state.activeFolder = folder;
    if (route.address) {
      var match = '';
      for (var i = 0; i < state.identities.length; i++) {
        if (state.identities[i].address.toLowerCase() === route.address.toLowerCase()) {
          match = state.identities[i].address;
          break;
        }
      }
      if (match) {
        var mobileView = (hist && hist.mobileView) || 'list';
        if (mobileView !== 'detail' && mobileView !== 'list' && mobileView !== 'folders') {
          mobileView = 'list';
        }
        await selectIdentity(match, {
          folder: folder,
          skipUrl: true,
          skipMobile: true
        });
        if (opts.seedMobileStack && window.innerWidth <= 820 && mobileView === 'list') {
          history.replaceState(
            { scope: 'inbox', mobileView: 'folders', folder: folder },
            '',
            '/ui/inbox'
          );
          history.pushState(
            { scope: 'inbox', mobileView: 'list', folder: folder },
            '',
            pathForScope('inbox', { address: match, folder: folder })
          );
        }
        inboxView.dataset.mobileView = mobileView;
        if (mobileView === 'detail' && hist && hist.messageId) {
          await selectMessage(hist.messageId, { skipPush: true });
        }
      }
    } else if (window.innerWidth <= 820) {
      inboxView.dataset.mobileView = 'folders';
    } else {
      inboxView.dataset.mobileView = 'list';
    }
    renderFolderNav();
    if (!opts.fromPop) syncUrlFromScope(true);
  }

  function navigateTo(scope, extras) {
    history.pushState({ scope: scope }, '', pathForScope(scope, extras || {}));
    applyRoute(parseLocationRoute(), { announce: '' });
  }

  /* ---- scope 迁移：任一时刻恰好一个可见 <main>（overview / notifications / tasks / inbox / configure / plan） ---- */
  function applyScope(next, options) {
    var opts = options || {};
    var overviewActive = next === 'overview';
    var notifyActive = next === 'notifications';
    var tasksActive = next === 'tasks';
    var inboxActive = next === 'inbox';
    var cfgIdentitiesActive = next === 'configure-identities';
    var cfgPushActive = next === 'configure-push';
    var cfgClientsActive = next === 'configure-clients';
    var cfgDomainsActive = next === 'configure-domains';
    var planActive = next === 'plan';
    var SCOPE_META = {
      overview: {
        title: 'Home',
        docTitle: 'OpenAgent Home',
        skip: 'Skip to Home',
        href: '#overview-panel',
        mobileView: 'overview'
      },
      notifications: {
        title: 'Alerts',
        docTitle: 'OpenAgent Alerts',
        skip: 'Skip to Alerts',
        href: '#notify-panel',
        mobileView: 'notifications'
      },
      tasks: {
        title: 'Tasks',
        docTitle: 'OpenAgent Tasks',
        skip: 'Skip to tasks',
        href: '#tasks-panel',
        mobileView: 'tasks-list'
      },
      'configure-identities': {
        title: 'Identities',
        docTitle: 'OpenAgent Identities',
        skip: 'Skip to identities',
        href: '#configure-identities-panel',
        mobileView: ''
      },
      'configure-push': {
        title: 'Push & Devices',
        docTitle: 'OpenAgent Push & Devices',
        skip: 'Skip to push',
        href: '#configure-push-panel',
        mobileView: ''
      },
      'configure-clients': {
        title: 'Connected apps',
        docTitle: 'OpenAgent Connected apps',
        skip: 'Skip to Connected apps',
        href: '#configure-clients-panel',
        mobileView: ''
      },
      'configure-domains': {
        title: 'Domains',
        docTitle: 'OpenAgent Domains',
        skip: 'Skip to domains',
        href: '#configure-domains-panel',
        mobileView: ''
      },
      plan: {
        title: 'Plan',
        docTitle: 'OpenAgent Plan',
        skip: 'Skip to Plan',
        href: '#plan-panel',
        mobileView: ''
      },
      inbox: {
        title: 'Mail',
        docTitle: 'OpenAgent Mail',
        skip: 'Skip to Mail',
        href: '#main-content',
        mobileView: ''
      }
    };
    var meta = SCOPE_META[next] || SCOPE_META.inbox;
    state.scope = next;
    inboxView.dataset.scope = next;
    overviewPanel.hidden = !overviewActive;
    notifyPanel.hidden = !notifyActive;
    tasksPanel.hidden = !tasksActive;
    mainContent.hidden = !inboxActive;
    configureIdentitiesPanel.hidden = !cfgIdentitiesActive;
    configurePushPanel.hidden = !cfgPushActive;
    configureClientsPanel.hidden = !cfgClientsActive;
    configureDomainsPanel.hidden = !cfgDomainsActive;
    planPanel.hidden = !planActive;
    identityPanel.hidden = !inboxActive;
    mobileIdentityContainer.hidden = !inboxActive;
    viewTitle.textContent = meta.title;
    document.title = meta.docTitle;
    skipLink.textContent = meta.skip;
    skipLink.setAttribute('href', meta.href);
    if (meta.mobileView) inboxView.dataset.mobileView = meta.mobileView;
    renderIdentities();
    renderAppNav();
    if (!opts.skipUrl) syncUrlFromScope(opts.replaceUrl);
    if (opts.announce) announce(opts.announce);
  }
