/** Inbox 游标「Load more」；Tasks/Notifications 后续接入。 */
export const PAGINATOR_JS = "  function renderLoadMore(button, hasMore, onLoad) {\n    if (!button) return;\n    button.hidden = !hasMore;\n    button.disabled = !hasMore;\n    button.onclick = hasMore ? onLoad : null;\n  }\n\n";
