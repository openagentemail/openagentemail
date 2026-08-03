// Clean-compose task acceptance probe. Start a fresh stack first, then run:
// TASK_ACCEPTANCE_API=http://127.0.0.1:3100 \
// TASK_ACCEPTANCE_ADMIN_KEY=... \
// npx -y bun@1.2.21 run dev/task-acceptance.mjs
//
// It exercises the v0.4 loop end to end: A task_create(wait) -> B sees the
// trusted agent wake -> B updates completed+result -> A receives the terminal
// task response. No SSH, IMAP login, ntfy topic or device credential is used.

const api = (process.env.TASK_ACCEPTANCE_API ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const adminKey = process.env.TASK_ACCEPTANCE_ADMIN_KEY;
if (!adminKey) throw new Error('Set TASK_ACCEPTANCE_ADMIN_KEY to the clean stack API_KEYS value.');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, token, method = 'GET', body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const suffix = Date.now().toString(36);
const alpha = await request('/v1/identities', adminKey, 'POST', { localpart: `task-alpha-${suffix}` });
const bravo = await request('/v1/identities', adminKey, 'POST', { localpart: `task-bravo-${suffix}` });
console.log(`[acceptance] identities: A=${alpha.address}, B=${bravo.address}`);

// Leave this in flight: the task endpoint waits for the terminal stamped
// reply while B's independent agent loop notices the notification and works.
const taskPromise = request('/v1/tasks', alpha.token, 'POST', {
  to: bravo.address,
  subject: 'v0.4 acceptance task',
  body: 'Return the exact structured acceptance result.',
  wait: true,
});

const wake = await waitFor(async () => {
  const history = await request('/v1/notify/messages?topic=self&since=5m', bravo.token);
  return history.messages.length > 0 ? history.messages : null;
}, 'B agent notification');
console.log(`[acceptance] B listener wake: ${wake.length} private notification(s)`);

const assigned = await waitFor(async () => {
  const listed = await request('/v1/tasks?state=submitted', bravo.token);
  return listed.tasks.find((entry) => entry.to === bravo.address && entry.subject === 'v0.4 acceptance task');
}, 'task delivery to B');
console.log(`[acceptance] B listener found task ${assigned.id}`);

await request(`/v1/tasks/${assigned.id}/state`, bravo.token, 'POST', {
  state: 'working',
  body: 'Acceptance worker started.',
});
await request(`/v1/tasks/${assigned.id}/state`, bravo.token, 'POST', {
  state: 'completed',
  body: 'Acceptance worker finished.',
  result: { ok: true, source: 'task-acceptance' },
});

const completed = await taskPromise;
if (completed.state !== 'completed' || completed.result?.ok !== true) {
  throw new Error(`A did not receive completed+result: ${JSON.stringify(completed)}`);
}
console.log(`[acceptance] A wait returned ${completed.state} with result=${JSON.stringify(completed.result)}`);
console.log('[acceptance] PASS A task_create(wait) -> B wake/listener -> completed result');
