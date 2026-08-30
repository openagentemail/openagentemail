import { expect, test } from 'bun:test';
import { dispatchPausedRequest } from '../dev/acceptance-fetch-dispatch.mjs';

test('paused-fetch parsing and rejected stubs fall back once without unhandled rejections', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const run = async (request: { url: string; method?: string }, stubs: Record<string, unknown> = {}, failFallback = false) => {
      const sent: string[] = [];
      const records: Array<[string, string]> = [];
      await dispatchPausedRequest({ requestId: `request-${request.url}`, request }, {
        overviewStub: stubs.overviewStub,
        identitiesStub: null,
        tasksStub: stubs.tasksStub,
        send: async (method: string) => {
          sent.push(method);
          if (failFallback && method === 'Fetch.continueRequest') throw new Error('CDP disconnected');
        },
        delay: async () => {},
        record: (kind: string, detail: string) => records.push([kind, detail]),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { sent, records };
    };

    const malformedUrl = await run({ url: 'not a URL' });
    expect(malformedUrl.sent).toEqual(['Fetch.continueRequest']);
    expect(malformedUrl.records[0]![1]).toContain('malformed request URL');

    const malformedPercent = await run(
      { url: 'http://preview.test/ui/api/tasks/%zz/decision', method: 'POST' },
      { tasksStub: async (request: { url: string }) => ({ status: 200, body: { id: decodeURIComponent(new URL(request.url).pathname.split('/')[4]!) } }) },
      true,
    );
    expect(malformedPercent.sent).toEqual(['Fetch.continueRequest']);
    expect(malformedPercent.records.map(([kind]) => kind)).toEqual(['Fetch.requestPaused', 'Fetch.continueRequest']);

    const rejectedStub = await run(
      { url: 'http://preview.test/ui/api/overview', method: 'GET' },
      { overviewStub: async () => { throw new Error('fixture rejected'); } },
    );
    expect(rejectedStub.sent).toEqual(['Fetch.continueRequest']);
    expect(rejectedStub.records[0]![1]).toContain('stub failed: fixture rejected');
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('only known stale fulfill failures are ignored after exactly one fulfill attempt', async () => {
  const run = async (message: string) => {
    const sent: string[] = [];
    const records: Array<[string, string]> = [];
    await dispatchPausedRequest({ requestId: 'stale-request', request: { url: 'http://preview.test/ui/api/overview' } }, {
      overviewStub: async () => ({ status: 200, body: {} }),
      identitiesStub: null,
      tasksStub: null,
      send: async (method: string) => {
        sent.push(method);
        if (method === 'Fetch.fulfillRequest') throw new Error(message);
      },
      delay: async () => {},
      record: (kind: string, detail: string) => records.push([kind, detail]),
    });
    return { sent, records };
  };

  const stale = await run('Invalid InterceptionId.');
  expect(stale.sent).toEqual(['Fetch.fulfillRequest']);
  expect(stale.records).toEqual([]);

  const invalidRequestId = await run('Invalid requestId.');
  expect(invalidRequestId.sent).toEqual(['Fetch.fulfillRequest']);
  expect(invalidRequestId.records).toEqual([['Fetch.fulfillRequest', 'fulfill failed: Invalid requestId.']]);

  const unexpected = await run('CDP disconnected');
  expect(unexpected.sent).toEqual(['Fetch.fulfillRequest']);
  expect(unexpected.records).toEqual([['Fetch.fulfillRequest', 'fulfill failed: CDP disconnected']]);
});
