// Development-only Chromium acceptance probe.
// Start dev/preview.ts first, then run:
// PREVIEW_BASE=http://127.0.0.1:4310 npx -y bun@1.2.21 run dev/acceptance.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:4310';
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? 9334);
const candidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((candidate) => existsSync(candidate));
if (!chrome) throw new Error('Chromium executable not found; set CHROME_BIN');

const profile = mkdtempSync(join(tmpdir(), 'oae-ui-acceptance-'));
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(action, description) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`${description}: ${lastError?.message ?? 'timed out'}`);
}

let socket;
let nextId = 0;
const pending = new Map();
const violations = [];
const requestedExternalUrls = new Set();

function record(kind, value) {
  violations.push(`${kind}: ${String(value).slice(0, 300)}`);
}

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error('browser evaluation failed');
  return result.result?.value;
}

async function waitFor(expression, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  await retry(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (!response.ok) throw new Error(`debug endpoint returned ${response.status}`);
      return response.json();
    },
    'Chromium did not start',
  );

  const target = await retry(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${base}/ui`)}`,
        { method: 'PUT' },
      );
      if (!response.ok) throw new Error(`target endpoint returned ${response.status}`);
      return response.json();
    },
    'Chromium target could not be created',
  );

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }

    if (message.method === 'Network.loadingFailed') {
      record('Network.loadingFailed', message.params.errorText);
    } else if (
      message.method === 'Network.responseReceived' &&
      message.params.response.status >= 400
    ) {
      record(
        'Network.responseReceived',
        `${message.params.response.status} ${message.params.response.url}`,
      );
    } else if (
      message.method === 'Network.requestWillBeSent' &&
      !message.params.request.url.startsWith(base) &&
      !message.params.request.url.startsWith('data:')
    ) {
      requestedExternalUrls.add(message.params.request.url);
    } else if (
      message.method === 'Log.entryAdded' &&
      message.params.entry.level === 'error'
    ) {
      record('Log.entryAdded', message.params.entry.text);
    } else if (message.method === 'Page.javascriptDialogOpening') {
      record('Page.javascriptDialogOpening', message.params.message);
      void send('Page.handleJavaScriptDialog', { accept: false });
    } else if (message.method === 'Runtime.exceptionThrown') {
      record(
        'Runtime.exceptionThrown',
        message.params.exceptionDetails.text,
      );
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      if (type === 'error' || type === 'assert') {
        record('Runtime.consoleAPICalled', type);
      }
    } else if (
      message.method === 'Page.frameNavigated' &&
      message.params.frame.parentId === undefined &&
      !message.params.frame.url.startsWith(base)
    ) {
      record('Page.frameNavigated', message.params.frame.url);
    }
  });

  await Promise.all([
    send('Page.enable'),
    send('Runtime.enable'),
    send('Network.enable'),
    send('Log.enable'),
  ]);
  await send('Page.navigate', { url: `${base}/ui` });
  await waitFor(
    "document.readyState === 'complete' && !document.querySelector('#login-view').hidden",
    'login screen',
  );

  await evaluate(`(() => {
    const input = document.querySelector('#login-token');
    input.value = 'preview-token';
    document.querySelector('#login-form').requestSubmit();
    return true;
  })()`);
  await waitFor(
    "!document.querySelector('#inbox-view').hidden && document.querySelectorAll('.message-button').length > 0",
    'message list',
  );
  await evaluate("document.querySelector('.message-button').click()");
  await waitFor(
    "document.querySelector('.detail-subject') !== null",
    'plain-text detail',
  );
  await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.tab')).find(
      (candidate) => candidate.textContent === 'HTML'
    );
    tab.click();
    return true;
  })()`);
  await waitFor(
    "document.querySelector('.html-frame') !== null",
    'isolated HTML frame',
  );
  await delay(250);

  const containment = await evaluate(`(() => {
    const frame = document.querySelector('.html-frame');
    return {
      parentMarked: document.body.dataset.pwned === 'yes',
      frameOpaque: frame.contentDocument === null,
      location: location.href
    };
  })()`);
  if (containment.parentMarked) record('containment', 'email script changed the parent');
  if (!containment.frameOpaque) record('containment', 'sandboxed frame origin is readable');
  if (containment.location !== `${base}/ui`) {
    record('navigation', containment.location);
  }
  for (const url of requestedExternalUrls) record('external request', url);

  if (violations.length) {
    throw new Error(`Browser acceptance violations:\n${violations.join('\n')}`);
  }
  console.log('UI browser acceptance passed: no resource, script, dialog, navigation, or isolation failures.');
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill('SIGTERM');
  rmSync(profile, { recursive: true, force: true });
}
