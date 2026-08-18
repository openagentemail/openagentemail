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

const REQUIRED_TOOLS = [
  'mail_list_identities',
  'mail_list_messages',
  'mail_read_message',
  'mail_send',
  'mail_mark_seen',
];

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

  test('4: MCP tool handshake rejects empty, invalid, and incomplete tool lists', async () => {
    await expectCode(() => validateToolList({ tools: [] }), EXIT.MCP_VERIFY_FAILED);
    await expectCode(() => validateToolList({ tools: [{ name: 42 }] }), EXIT.MCP_VERIFY_FAILED);
    await expectCode(() => validateToolList({ tools: [{ name: 'only-one' }] }), EXIT.MCP_VERIFY_FAILED);
    await expectCode(
      () => validateToolList({ tools: REQUIRED_TOOLS.filter((name) => name !== 'mail_send').map((name) => ({ name })) }),
      EXIT.MCP_VERIFY_FAILED,
    );
  });

  test('MCP tool handshake accepts seven tools when every required mail tool is present', () => {
    expect(() => validateToolList({
      tools: [...REQUIRED_TOOLS, 'notify_messages', 'task_list'].map((name) => ({ name })),
    })).not.toThrow();
  });

  test('MCP tool handshake accepts fifteen tools including extra notify and task tools', () => {
    expect(() => validateToolList({
      tools: [
        ...REQUIRED_TOOLS,
        'notify_messages',
        'notify_register',
        'task_list',
        'task_create',
        'task_get',
        'task_reply',
        'mail_delete_messages',
        'mail_wait',
        'mail_get_source',
        'mail_get_message',
      ].map((name) => ({ name })),
    })).not.toThrow();
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
