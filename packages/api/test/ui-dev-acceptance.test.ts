import { describe, expect, test } from 'bun:test';

describe('development browser acceptance harness', () => {
  test('fails on resource errors as well as script and navigation violations', async () => {
    const source = await Bun.file(
      new URL('../dev/acceptance.mjs', import.meta.url),
    ).text();

    expect(source).toContain('Network.loadingFailed');
    expect(source).toContain('Network.responseReceived');
    expect(source).toContain('Log.entryAdded');
    expect(source).toContain('Page.javascriptDialogOpening');
    expect(source).toContain('Runtime.consoleAPICalled');
  });
});
