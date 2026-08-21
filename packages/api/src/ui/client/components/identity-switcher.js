  /* 侧栏地址项与移动 <select> 是 Overview / Notifications / Tasks 之外的入口：在非 inbox
     scope 下必须走 openAddress（切 scope、播报、聚焦），否则会在不可见的 inbox
     里取消息、画面却停在当前面板。 */
  function activateAddress(address) {
    if (state.scope === 'overview' || state.scope === 'notifications' || state.scope === 'tasks' ||
        isConfigureScope(state.scope)) {
      openAddress(address);
      return;
    }
    selectIdentity(address);
  }

  function filteredIdentities() {
    var needle = state.identityFilter.toLowerCase();
    if (!needle) return state.identities;
    return state.identities.filter(function (identity) {
      return identity.address.toLowerCase().includes(needle) ||
        (identity.name || '').toLowerCase().includes(needle);
    });
  }

  function renderIdentities() {
    identityList.replaceChildren();
    mobileIdentity.replaceChildren();
    identityCount.textContent = String(state.identities.length);

    if (isAdmin()) {
      /* 空串永不可能是合法地址，所以它是安全的"回总览"哨兵值。 */
      var overviewOption = document.createElement('option');
      overviewOption.value = '';
      overviewOption.textContent = 'Overview — all addresses';
      overviewOption.selected = state.scope === 'overview';
      mobileIdentity.append(overviewOption);
    }

    /* 通知/工单面板哨兵：合法地址不会以双下划线开头。 */
    var notifyOption = document.createElement('option');
    notifyOption.value = '__notifications__';
    notifyOption.textContent = 'Notifications — push history';
    notifyOption.selected = state.scope === 'notifications';
    mobileIdentity.append(notifyOption);

    var tasksOption = document.createElement('option');
    tasksOption.value = '__tasks__';
    tasksOption.textContent = 'Tasks — ticket board';
    tasksOption.selected = state.scope === 'tasks';
    mobileIdentity.append(tasksOption);

    state.identities.forEach(function (identity) {
      var option = document.createElement('option');
      option.value = identity.address;
      option.textContent = identity.name ? identity.name + ' — ' + identity.address : identity.address;
      option.selected = state.scope === 'inbox' && identity.address === state.activeAddress;
      mobileIdentity.append(option);
    });

    if (isAdmin()) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'identity-button overview-nav';
      button.setAttribute('aria-current', state.scope === 'overview' ? 'true' : 'false');
      var overviewName = document.createElement('strong');
      overviewName.textContent = 'Overview';
      var overviewHint = document.createElement('span');
      overviewHint.textContent = 'All addresses';
      button.append(overviewName, overviewHint);
      button.addEventListener('click', function () {
        enterOverview({ announce: 'Back to overview' });
      });
      item.append(button);
      identityList.append(item);
    }

    var notifyItem = document.createElement('li');
    var notifyButton = document.createElement('button');
    notifyButton.type = 'button';
    notifyButton.className = 'identity-button overview-nav';
    notifyButton.setAttribute('aria-current', state.scope === 'notifications' ? 'true' : 'false');
    var notifyName = document.createElement('strong');
    notifyName.textContent = 'Notifications';
    var notifyHint = document.createElement('span');
    notifyHint.textContent = 'Push history';
    notifyButton.append(notifyName, notifyHint);
    notifyButton.addEventListener('click', function () {
      enterNotifications({ announce: 'Opened notifications' });
    });
    notifyItem.append(notifyButton);
    identityList.append(notifyItem);

    var tasksItem = document.createElement('li');
    var tasksButton = document.createElement('button');
    tasksButton.type = 'button';
    tasksButton.className = 'identity-button overview-nav';
    tasksButton.setAttribute('aria-current', state.scope === 'tasks' ? 'true' : 'false');
    var tasksName = document.createElement('strong');
    tasksName.textContent = 'Tasks';
    var tasksHint = document.createElement('span');
    tasksHint.textContent = 'Ticket board';
    tasksButton.append(tasksName, tasksHint);
    tasksButton.addEventListener('click', function () {
      enterTasks({ announce: 'Opened tasks' });
    });
    tasksItem.append(tasksButton);
    identityList.append(tasksItem);

    filteredIdentities().forEach(function (identity) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'identity-button';
      button.setAttribute(
        'aria-current',
        state.scope === 'inbox' && identity.address === state.activeAddress ? 'true' : 'false'
      );
      var name = document.createElement('strong');
      name.textContent = identity.name || identity.address.split('@')[0];
      var address = document.createElement('span');
      address.textContent = identity.address;
      button.append(name, address);
      button.addEventListener('click', function () {
        activateAddress(identity.address);
      });
      item.append(button);
      identityList.append(item);
    });
  }

