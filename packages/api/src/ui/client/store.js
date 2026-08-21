  /* URL 由 router 接管（History API 真子路径）；仍会在启动时 replace 规范化。 */

  /* 客户端唯一的新鲜度阈值（与服务端 FRESH_MS 同值）。不存在第二个 TTL。 */
  var FRESH_MS = 15000;
  var POLL_LIMIT = 15;
  var POLL_WINDOW_MS = 20000;
  /* 通知面板 DOM 行数上限：12h 窗口可能数千条，全量建节点会卡死页面。 */
  var NOTIFY_RENDER_LIMIT = 500;
  /* 单工单时间线条目上限：长历史不全量建节点。服务端列表已按 20/50/100 分页。 */
  var TASK_TIMELINE_RENDER_LIMIT = 200;
  /* 与 lib/tasks.ts RESULT_MARKER 逐字一致；时间线正文剥离用。 */
  var TASK_RESULT_MARKER = '<!-- openagent.email task result -->';
  var SORT_COLUMNS = [
    { key: 'address', label: 'Address' },
    { key: 'name', label: 'Name' },
    { key: 'count', label: 'Messages' },
    { key: 'unseen', label: 'Unseen' },
    { key: 'last', label: 'Last' },
    { key: 'created', label: 'Created' }
  ];

  var state = {
    me: null,
    identities: [],
    identityFilter: '',
    activeAddress: '',
    activeFolder: 'inbox',
    messages: [],
    nextCursor: '',
    activeMessageId: '',
    detail: null,
    bodyView: 'plain',
    sourceCache: null,
    scope: 'inbox',
    overviewStatus: 'idle',
    overview: null,
    overviewMessage: '',
    overviewFilter: '',
    overviewSort: { key: 'last', dir: 'desc' },
    overviewGen: 0,
    /* Generation of the in-flight loadOverviewCycle (0 when none owns pending). */
    overviewCycleGen: 0,
    overviewPolls: 0,
    overviewRetryAt: 0,
    overviewPending: false,
    overviewLoadingSince: 0,
    returnAddress: '',
    /* address -> true while a push-tier PUT is in flight (survives re-render). */
    tierPending: {},
    devices: [],
    devicesStatus: 'idle',
    /* 设备列表拉取代际：新请求 / 登出 bump，过期响应不得写回。 */
    deviceLoadGen: 0,
    /* 通知记录：合并后的行（含逻辑 topic），以及加载态 */
    notifyMessages: [],
    notifyStatus: 'idle',
    notifyMessage: '',
    notifyFilter: '',
    notifyUpdatedAt: 0,
    notifyPending: false,
    /* 上次成功拉取对应的 topic 集合指纹，避免 All 误用单路缓存。 */
    notifyFetchKey: '',
    notifyLogItems: [],
    notifyLogFetchKey: '',
    notifyNextCursor: '',
    notifyLevelFilter: '',
    notifyFrom: '',
    notifyTo: '',
    notifyLimit: 20,
    notifySource: 'log',
    notifySummary: null,
    notifySummaryStatus: 'idle',
    notifyDiagnostics: null,
    notifyRevealed: {},
    notifyVerifyPending: false,
    /* 任务工单：列表 + 详情缓存；默认 Active tab */
    tasks: [],
    tasksStatus: 'idle',
    tasksMessage: '',
    tasksFilter: 'active',
    tasksPeriod: '30d',
    tasksLimit: 20,
    tasksNextCursor: '',
    tasksTotalApprox: 0,
    tasksUpdatedAt: 0,
    tasksPending: false,
    /* 上次成功拉取对应的 status|period|limit 指纹，避免切筛选误用旧缓存行。 */
    tasksFetchKey: '',
    activeTaskId: '',
    taskDetail: null,
    taskDetailStatus: 'idle',
    taskDetailMessage: '',
    /* Configure · Push 当前编辑的身份（admin 可切）。 */
    configurePushAddress: ''
  };
  var refreshTask = null;
  var refreshController = null;
  var detailController = null;
  var sourceController = null;
  var overviewController = null;
  var overviewTimer = null;
  var notifyController = null;
  var tasksController = null;
  var taskDetailController = null;

