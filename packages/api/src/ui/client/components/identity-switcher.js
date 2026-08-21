  /* 地址只在 Mail 中列出；未来其它页的地址链接仍须先进入 Mail。 */
  function activateAddress(address) {
    if (state.scope !== 'inbox') {
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

    state.identities.forEach(function (identity) {
      var option = document.createElement('option');
      option.value = identity.address;
      option.textContent = identity.name ? identity.name + ' — ' + identity.address : identity.address;
      option.selected = state.scope === 'inbox' && identity.address === state.activeAddress;
      mobileIdentity.append(option);
    });

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
