// ESLint 只管辖 #520-A 从字符串模块还原出的 UI 真文件（src/ui/**/*.js），
// 不接管仓内其它任何代码。
//
// 这些文件是 /ui/app.js 的拼接片段（assets.ts 固定顺序拼接，字节级金标钉死）：
// 每个片段按独立程序解析，跨片段的声明/使用关系对单文件 lint 不可见，
// 因此 no-undef / no-unused-vars 必须关闭（store.js 声明、后续片段使用是常态）。
// 主要价值：逐片段语法校验（括号/async 错位会在提取或后续编辑时当场红）
// 以及与 ui-assets.test.ts sink 断言同源的解析层硬禁令。
export default [
  {
    files: ['src/ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2019,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        console: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        FileReader: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
      },
    },
    rules: {
      // 安全 sink 硬禁令：与测试契约（无 eval/new Function/innerHTML）同源。
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      'no-with': 'error',
      // 低成本正确性规则（片段内自洽，不依赖跨文件信息）。
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      // 以下两条刻意不启用（除 no-undef/no-unused-vars 外）：
      //   no-redeclare —— 冻结的原始代码在 inbox.js 存在同作用域 var 重声明（合法 var 语义）；
      //   no-script-url —— empty-state.js 的协议消毒逻辑必须包含 'javascript:' 字面量。
      // 片段字节被 /ui/app.js 金标钉死，不能加行内豁免注释，只能在 config 层面如实配置。
      // 拼接事实：跨片段变量不可见，这两条必须关（见文件头注释）。
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
