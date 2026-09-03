  /* token / confirm / create 仪式：关闭时消费一次 cancel 副作用，并恢复 opener 焦点。 */
  /* 确认框取消副作用：声明收口到 modal 模块，api/push-devices 只赋值。 */
  var confirmModalOnCancel = null;
  var modalOpener = null;
  var modalGeneration = 0;

  function elementInsideModal(node) {
    if (!node || !node.closest) return false;
    return !!(node.closest('#token-modal') || node.closest('#confirm-modal') || node.closest('#create-modal') || node.closest('#device-add-modal') || node.closest('#device-pair-modal'));
  }

  function closeAllModals(options) {
    var opts = options || {};
    tokenModal.hidden = true;
    confirmModal.hidden = true;
    createModal.hidden = true;
    deviceAddModal.hidden = true;
    devicePairModal.hidden = true;
    devicePairPassword.textContent = '';
    devicePairQr.replaceChildren();
    devicePairServer.textContent = '';
    devicePairUser.textContent = '';
    devicePairTopics.textContent = '';
    devicePairName.textContent = '';
    tokenValue.textContent = '';
    tokenModalTitle.textContent = 'Token';
    tokenCopyButton.classList.remove('copied');
    confirmModalTitle.textContent = 'Confirm';
    confirmModalText.textContent = '';
    confirmModalRisk.textContent = '';
    confirmModalRisk.hidden = true;
    confirmModalConfirm.textContent = 'Confirm';
    confirmModalConfirm.onclick = null;
    // F107: an indirect close (background action opening another modal) must
    // still run the pending cancel side-effect (restore tier select) — the
    // callback is consumed exactly once either way.
    var onCancel = confirmModalOnCancel;
    confirmModalOnCancel = null;
    if (onCancel) onCancel();
    var opener = modalOpener;
    modalOpener = null;
    /* 路由关闭 / 用户关闭使进行中的异步 close 失效；链式开窗 keepGeneration。 */
    if (!opts.keepGeneration) modalGeneration += 1;
    /* 链式开下一扇窗时不要抢焦点；节点若已被 onCancel 卸下则跳过。 */
    if (opts.skipFocus) return;
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (_err) { /* 节点可能已卸下 */ }
    }
  }

  /* 打开任一 modal 前记录当前焦点；Cancel/Close/Escape/路由切换都走 closeAllModals。
     Create→Token：焦点已在即将关闭的 create 窗内，必须保留上一层 opener。 */
  function beginModal() {
    var opener = document.activeElement;
    var previous = modalOpener;
    /* disabled 提交钮会把焦点打到 body，Create→Token 必须仍认上一层 opener。 */
    var lostFocus = !opener || opener === document.body;
    closeAllModals({ skipFocus: true, keepGeneration: true });
    if (elementInsideModal(opener) || (lostFocus && previous)) {
      modalOpener = previous;
    } else if (opener && opener !== document.body && typeof opener.focus === 'function') {
      modalOpener = opener;
    }
    modalGeneration += 1;
    /* 新窗按钮必须可点：成功关窗会 bump，旧 finally 跳过复位；残留 disabled 由这里清掉。 */
    confirmModalConfirm.disabled = false;
    confirmModalCancel.disabled = false;
    createModalSubmit.disabled = false;
    deviceAddSubmit.disabled = false;
    return modalGeneration;
  }

  function showTokenModal(token, title) {
    beginModal();
    tokenModalTitle.textContent = title || 'Token';
    tokenValue.textContent = token;
    tokenModal.hidden = false;
    tokenCopyButton.focus();
  }

  function populateCreateDomain(domains) {
    while (createDomain.firstChild) {
      createDomain.removeChild(createDomain.firstChild);
    }
    var list = (domains && domains.length > 0) ? domains : [];
    if (list.length === 0) {
      createDomain.disabled = true;
      return;
    }
    createDomain.disabled = false;
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement('option');
      opt.value = list[i];
      opt.textContent = list[i];
      createDomain.appendChild(opt);
    }
  }

  async function showCreateModal() {
    if (!isAdmin()) return;
    beginModal();
    createName.value = '';
    createLocalpart.value = '';
    try {
      var data = await apiJson('/ui/api/domains');
      var list = (data && data.all && data.all.length > 0)
        ? data.all
        : (data && data.primary ? [data.primary] : []);
      populateCreateDomain(list);
    } catch (e) {
      while (createDomain.firstChild) {
        createDomain.removeChild(createDomain.firstChild);
      }
      createDomain.disabled = true;
    }
    createModal.hidden = false;
    createName.focus();
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (tokenModal.hidden && confirmModal.hidden && createModal.hidden && deviceAddModal.hidden && devicePairModal.hidden) return;
    event.preventDefault();
    closeAllModals();
  });

