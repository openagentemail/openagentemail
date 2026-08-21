  function enterConfigureDomains(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('configure-domains', { announce: opts.announce });
    renderEmptyState(configureDomainsState, {
      title: 'Custom domains are on the roadmap',
      purpose: 'This instance keeps using the configured primary domain. Multi-suffix routing and certificates are not available yet, so this page has no controls to click.'
    });
    configureDomainsPanel.focus({ preventScroll: true });
  }

  function enterPlan(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('plan', { announce: opts.announce });
    renderEmptyState(planState, {
      title: 'Self-hosted instance',
      purpose: 'This dashboard does not bill, quota, or upgrade a self-hosted deployment. Hosted plan meters will appear here only when a real control-plane contract exists.',
      docsHref: 'https://openagent.email/docs/reference/api/',
      docsLabel: 'Read the self-hosted API docs'
    });
    planPanel.focus({ preventScroll: true });
  }

