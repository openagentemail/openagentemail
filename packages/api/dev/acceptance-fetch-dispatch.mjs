function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedStaleInterceptionError(error) {
  return /^Invalid InterceptionId\.?$/.test(errorText(error));
}

function note(record, kind, detail) {
  try { record(kind, detail); } catch (_error) { /* A reporting failure must not leak from CDP dispatch. */ }
}

async function continuePausedRequest(requestId, send, record, reason) {
  note(record, 'Fetch.requestPaused', reason);
  try {
    await send('Fetch.continueRequest', { requestId });
  } catch (error) {
    note(record, 'Fetch.continueRequest', `fallback failed: ${errorText(error)}`);
  }
}

export async function dispatchPausedRequest({ requestId, request }, {
  overviewStub, identitiesStub, tasksStub, send, delay, record,
}) {
  try {
    let url;
    try {
      url = new URL(request.url);
    } catch (error) {
      await continuePausedRequest(requestId, send, record, `malformed request URL: ${errorText(error)}`);
      return;
    }
    const requestPath = url.pathname;
    const stub = request.url.includes('/ui/api/overview')
      ? overviewStub
      : request.url.includes('/ui/api/identities')
        ? identitiesStub
        : requestPath === '/ui/api/tasks' || requestPath.startsWith('/ui/api/tasks/')
          ? tasksStub
        : null;
    if (!stub) {
      try {
        await send('Fetch.continueRequest', { requestId });
      } catch (error) {
        note(record, 'Fetch.continueRequest', `passthrough failed: ${errorText(error)}`);
      }
      return;
    }

    let fulfill;
    try {
      const reply = await stub(request);
      await delay(reply.delayMs ?? 0);
      fulfill = {
        requestId,
        responseCode: reply.status,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'cache-control', value: 'no-store' },
        ],
        body: Buffer.from(JSON.stringify(reply.body)).toString('base64'),
      };
    } catch (error) {
      await continuePausedRequest(requestId, send, record, `stub failed: ${errorText(error)}`);
      return;
    }
    try {
      await send('Fetch.fulfillRequest', fulfill);
    } catch (error) {
      // A fulfill attempt already resolves this interception; do not double-resolve it.
      if (!isExpectedStaleInterceptionError(error)) {
        note(record, 'Fetch.fulfillRequest', `fulfill failed: ${errorText(error)}`);
      }
    }
  } catch (error) {
    // This boundary keeps a future dispatcher regression from becoming unhandled.
    await continuePausedRequest(requestId, send, record, `dispatcher failed: ${errorText(error)}`);
  }
}
