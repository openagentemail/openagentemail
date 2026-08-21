  /* sensitive-content：默认遮蔽 •••，逐条展开，不写 localStorage。 */
  function renderSensitiveText(container, text, opts) {
    container.replaceChildren();
    var options = opts || {};
    if (!options.sensitive) {
      var plain = document.createElement('p');
      plain.className = 'notify-body-text';
      plain.textContent = text;
      container.append(plain);
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'sensitive-wrap';
    if (!options.expanded) {
      var mask = document.createElement('span');
      mask.className = 'sensitive-mask';
      mask.textContent = '•••';
      mask.setAttribute('aria-label', 'Sensitive content hidden');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiet sensitive-reveal';
      btn.textContent = 'Reveal';
      btn.addEventListener('click', function (event) {
        event.preventDefault();
        if (options.onToggle) options.onToggle();
      });
      wrap.append(mask, btn);
    } else {
      var body = document.createElement('p');
      body.className = 'notify-body-text';
      body.textContent = text;
      var hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'quiet sensitive-reveal';
      hide.textContent = 'Hide';
      hide.addEventListener('click', function (event) {
        event.preventDefault();
        if (options.onToggle) options.onToggle();
      });
      wrap.append(body, hide);
    }
    container.append(wrap);
  }

