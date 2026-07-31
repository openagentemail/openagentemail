import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from '../src/args.ts';
import { Reporter } from '../src/reporter.ts';
import { readSetupState } from '../src/state.ts';
import type { PromptAdapter, SelectOption } from '../src/types.ts';
import { runWizard } from '../src/wizard.ts';

const created: string[] = [];

function sink() {
  let value = '';
  return {
    stream: { write(chunk: string | Uint8Array) { value += String(chunk); return true; } },
    value: () => value,
  };
}

class QueuePrompts implements PromptAdapter {
  readonly messages: string[] = [];

  constructor(
    private readonly confirms: boolean[],
    private readonly selections: string[],
  ) {}

  intro() {}
  outro() {}

  async confirm(message: string): Promise<boolean> {
    this.messages.push(message);
    const value = this.confirms.shift();
    if (value === undefined) throw new Error(`No confirm answer for: ${message}`);
    return value;
  }

  async select(message: string, _options: SelectOption[]): Promise<string> {
    this.messages.push(message);
    const value = this.selections.shift();
    if (!value) throw new Error(`No select answer for: ${message}`);
    return value;
  }

  async multiselect(): Promise<string[]> { throw new Error('unexpected multiselect'); }
  async text(): Promise<string> { throw new Error('unexpected text'); }
  async password(): Promise<string> { throw new Error('unexpected password'); }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('wizard routing and resume', () => {
  test('recommendation branch prints both shopping groups and saves resumable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oae-wizard-'));
    created.push(root);
    const statePath = join(root, 'setup-state.json');
    const stdout = sink();
    const prompts = new QueuePrompts(
      [false, false, false, true, true],
      ['recommend', 'save'],
    );
    const result = await runWizard(
      parseArgs(['--no-fetch']),
      prompts,
      new Reporter(false, stdout.stream, sink().stream),
      { statePath },
    );

    expect(result.configuredClients).toEqual([]);
    expect(stdout.value()).toContain('VPS options:');
    expect(stdout.value()).toContain('Domain registrar options:');
    expect(stdout.value()).toContain('<PENDING_OWNER_LINK>');
    expect((await readSetupState(statePath))?.stage).toBe('recommendations');
  });

  test('an existing state changes the first question to Continue where you left off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oae-wizard-resume-'));
    created.push(root);
    const statePath = join(root, 'setup-state.json');
    const initialPrompts = new QueuePrompts(
      [false, true, true],
      ['recommend', 'save'],
    );
    await runWizard(
      parseArgs(['--no-fetch']),
      initialPrompts,
      new Reporter(false, sink().stream, sink().stream),
      { statePath },
    );

    const resumed = new QueuePrompts([true], ['save']);
    await runWizard(
      parseArgs(['--no-fetch']),
      resumed,
      new Reporter(false, sink().stream, sink().stream),
      { statePath },
    );
    expect(resumed.messages[0]).toBe('Continue where you left off?');
  });
});
