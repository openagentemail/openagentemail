  function renderLoadMore(button, hasMore, onLoad) {
    if (!button) return;
    button.hidden = !hasMore;
    button.disabled = !hasMore;
    button.onclick = hasMore ? onLoad : null;
  }

