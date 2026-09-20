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
        title: t('plan.title.configuredInstanceDomains'),
        purpose: t('plan.copy.primaryDomain') + primary + (data && data.extra && data.extra.length > 0 ? t('plan.copy.secondaryDomains') + extra : t('plan.copy.noSecondaryDomainsConfiguredSetExtra'))
      });
    } catch (e) {
      if (gen !== configureDomainsGen || state.scope !== 'configure-domains') return;
      // Session expired already transitioned to login; skip fallback rendering.
      if (e && e.message === 'session_expired') return;
      renderEmptyState(configureDomainsState, {
        title: t('plan.title.configuredInstanceDomains'),
        purpose: t('plan.copy.primaryDomain') + (window.location.hostname || t('plan.copy.configuredViaEnvironment'))
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
      title: t('plan.title.selfHostedInstance'),
      purpose: t('plan.copy.thisDashboardDoesNotBillQuota'),
      docsHref: 'https://openagent.email/docs/reference/api/',
      docsLabel: t('plan.copy.readTheSelfHostedApiDocs')
    });
    planPanel.focus({ preventScroll: true });
  }

