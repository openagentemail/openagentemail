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
