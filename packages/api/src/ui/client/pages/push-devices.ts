/** Configure · Push & Devices（PR1 诚实空态）。 */
export const PUSH_DEVICES_PAGE_JS = "  function enterConfigurePush(options) {\n    var opts = options || {};\n    cancelOverview();\n    cancelNotifyLoad();\n    cancelTasksLoad();\n    applyScope('configure-push', { announce: opts.announce });\n    configurePushPanel.focus({ preventScroll: true });\n  }\n\n";
