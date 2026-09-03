  var configureDomainsGen = 0;

  async function enterConfigureDomains(options) {
    var opts = options || {};
    cancelOverview();
    cancelNotifyLoad();
    cancelTasksLoad();
    applyScope('configure-domains', { announce: opts.announce });
    var gen = ++configureDomainsGen;
    try {
      var data = await apiJson('/ui/api/domains');
      if (gen !== configureDomainsGen || state.scope !== 'configure-domains') return;
      var primary = (data && data.primary) || window.location.hostname;
      var extra = (data && data.extra && data.extra.length > 0) ? data.extra.join(', ') : 'None';
      renderEmptyState(configureDomainsState, {
        title: 'Configured instance domains',
        purpose: 'Primary domain: ' + primary + (data && data.extra && data.extra.length > 0 ? ' | Secondary domains: ' + extra : ' | No secondary domains configured (set EXTRA_DOMAINS in .env to add more).')
      });
    } catch (e) {
      if (gen !== configureDomainsGen || state.scope !== 'configure-domains') return;
      // Session expired already transitioned to login; skip fallback rendering.
      if (e && e.message === 'session_expired') return;
      renderEmptyState(configureDomainsState, {
        title: 'Configured instance domains',
        purpose: 'Primary domain: ' + (window.location.hostname || 'configured via environment')
      });
    }
    if (gen !== configureDomainsGen || state.scope !== 'configure-domains') return;
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

