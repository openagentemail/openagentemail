import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/args.ts';
import { checkApiHealth, tokenKind } from '../src/connect.ts';
import {
  DEMO_COMPOSE_OVERRIDE,
  DEMO_COMPOSE_PROJECT,
  assertDockerAvailable,
  demoComposeArgs,
  waitForDemoHealth,
} from '../src/demo.ts';
import { CliError, EXIT } from '../src/types.ts';
import { validateToolList } from '../src/verify.ts';

async function expectCode(operation: () => unknown | Promise<unknown>, code: number) {
  try {
    await operation();
    throw new Error('Expected operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(code);
  }
}

describe('documented exit codes', () => {
  test('demo Compose commands are isolated from a normal openagentemail stack', () => {
    expect(demoComposeArgs('up', '-d')).toEqual([
      'compose',
      '-p',
      DEMO_COMPOSE_PROJECT,
      '-f',
      'compose.yaml',
      '-f',
      DEMO_COMPOSE_OVERRIDE,
      'up',
      '-d',
    ]);
    expect(demoComposeArgs('down', '-v').join(' ')).toContain(
      `-p ${DEMO_COMPOSE_PROJECT}`,
    );
    expect(DEMO_COMPOSE_PROJECT).not.toBe('openagentemail');
  });

  test('1: invalid CLI input', async () => {
    await expectCode(() => parseArgs(['deploy']), EXIT.ERROR);
  });

  test('2: API is unreachable or not an openagent.email server', async () => {
    await expectCode(
      () => checkApiHealth('http://localhost:1', async () => {
        throw new Error('offline');
      }),
      EXIT.API_UNREACHABLE,
    );
  });

  test('3: token is invalid', async () => {
    await expectCode(
      () => tokenKind('http://localhost:3100', 'oa_bad', async () =>
        new Response('{}', { status: 401 })),
      EXIT.TOKEN_INVALID,
    );
  });

  test('4: MCP tool handshake is incomplete', async () => {
    await expectCode(() => validateToolList({ tools: [{ name: 'only-one' }] }), EXIT.MCP_VERIFY_FAILED);
  });

  test('5: Docker or Compose is missing', async () => {
    await expectCode(() => assertDockerAvailable({
      run: () => ({ status: 1, stdout: '', stderr: '' }),
    }), EXIT.DOCKER_MISSING);
  });

  test('6: demo health timeout', async () => {
    let now = 0;
    await expectCode(() => waitForDemoHealth({
      fetcher: async () => { throw new Error('not ready'); },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    }, 4_000), EXIT.DEMO_TIMEOUT);
  });
});
