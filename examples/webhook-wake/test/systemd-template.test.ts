import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const systemUnit = readFileSync(fileURLToPath(new URL('../templates/webhook-wake.service', import.meta.url)), 'utf8');
const userUnit = readFileSync(fileURLToPath(new URL('../templates/webhook-wake.user.service', import.meta.url)), 'utf8');
const runtimeEnv = readFileSync(fileURLToPath(new URL('../templates/runtime.env.example', import.meta.url)), 'utf8');

describe('systemd specifier policy', () => {
  test('system unit does not use manager %h/%U for HOME or XDG_RUNTIME_DIR', () => {
    expect(systemUnit).not.toMatch(/Environment=HOME=%h/);
    expect(systemUnit).not.toMatch(/Environment=XDG_RUNTIME_DIR=\/run\/user\/%U/);
    expect(systemUnit).toMatch(/^EnvironmentFile=\/etc\/webhook-wake\/runtime\.env$/m);
    expect(systemUnit).not.toMatch(/^EnvironmentFile=-/m);
    expect(systemUnit).toMatch(/ProtectHome=read-only/);
  });

  test('operator runtime.env example supplies a non-root context without secrets', () => {
    expect(runtimeEnv).toMatch(/^HOME=\/home\/example-operator$/m);
    expect(runtimeEnv).toMatch(/^XDG_RUNTIME_DIR=\/run\/user\/1000$/m);
    expect(runtimeEnv).not.toMatch(/\/root/);
    const assignments = runtimeEnv
      .split('\n')
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .join('\n');
    expect(assignments).not.toMatch(/whs_|oa_|API_KEY|SECRET|PASSWORD/i);
  });

  test('user unit may use %h/%U because user-mode specifiers are the calling user', () => {
    expect(userUnit).toMatch(/WantedBy=default\.target/);
    expect(userUnit).toMatch(/Environment=HOME=%h/);
    expect(userUnit).toMatch(/Environment=XDG_RUNTIME_DIR=\/run\/user\/%U/);
  });
});
