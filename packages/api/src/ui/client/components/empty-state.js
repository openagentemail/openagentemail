  /* 文档链接白名单：http(s) 绝对地址，或经 base 解析后同源的 / 相对路径；拒绝 //、javascript:、vbscript:、以及 data 协议。 */
  function allowedDocsHref(href) {
    if (!href || typeof href !== 'string') return '';
    var value = href.trim();
    if (!value) return '';
    var lowered = value.toLowerCase();
    if (lowered.indexOf('javascript:') === 0 || lowered.indexOf('vbscript:') === 0 || lowered.indexOf('data' + ':') === 0) return '';
    if (value.charAt(0) === '/') {
      if (value.charAt(1) === '/') return '';
      try {
        var parsedRel = new URL(value, window.location.href);
        if (parsedRel.origin !== window.location.origin) return '';
        var rel = parsedRel.pathname + parsedRel.search + parsedRel.hash;
        /* pathname 若以 // 开头，赋给 <a href> 会被当成协议相对 URL。 */
        if (!rel || rel.charAt(0) !== '/' || rel.charAt(1) === '/') return '';
        return rel;
      } catch (_errRel) {
        return '';
      }
    }
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.href;
    } catch (_err) {
      return '';
    }
  }

  function renderEmptyState(container, opts) {
    container.replaceChildren();
    var wrap = document.createElement('div');
    wrap.className = 'empty-state-card';
    var title = document.createElement('h3');
    title.textContent = opts.title;
    var purpose = document.createElement('p');
    purpose.className = 'muted';
    purpose.textContent = opts.purpose;
    wrap.append(title, purpose);
    if (opts.docsHref && opts.docsLabel) {
      var safeHref = allowedDocsHref(opts.docsHref);
      if (safeHref) {
        var link = document.createElement('a');
        link.className = 'empty-state-docs';
        link.href = safeHref;
        link.textContent = opts.docsLabel;
        link.rel = 'noopener noreferrer';
        if (safeHref.indexOf('http:') === 0 || safeHref.indexOf('https:') === 0) {
          link.target = '_blank';
        }
        wrap.append(link);
      }
    }
    if (opts.actionLabel && opts.onAction) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary empty-state-action';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', opts.onAction);
      wrap.append(btn);
    }
    container.append(wrap);
  }

