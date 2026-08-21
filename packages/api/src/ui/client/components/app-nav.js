  /* 全局导航：从 router 迁入；Overview 项仍由 configureSession 按 isAdmin 显隐。 */
  function closeNavDrawer() {
    var wasOpen = inboxView.getAttribute('data-nav-open') === 'true';
    inboxView.removeAttribute('data-nav-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navBackdrop.hidden = true;
    if (wasOpen) navToggle.focus();
  }

  function openNavDrawer() {
    inboxView.setAttribute('data-nav-open', 'true');
    navToggle.setAttribute('aria-expanded', 'true');
    navBackdrop.hidden = false;
    var current = appNav.querySelector('[aria-current="page"]');
    if (current) current.focus();
  }

  function renderAppNav() {
    var links = appNav.querySelectorAll('[data-nav]');
    Array.prototype.forEach.call(links, function (link) {
      var key = link.getAttribute('data-nav');
      if (key === state.scope) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!tokenModal.hidden || !confirmModal.hidden || !createModal.hidden) return;
    if (inboxView.getAttribute('data-nav-open') !== 'true') return;
    event.preventDefault();
    closeNavDrawer();
  });

