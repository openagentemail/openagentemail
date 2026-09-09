import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const systemUnit = readFileSync(fileURLToPath(new URL('../templates/webhook-wake.service', import.meta.url)), 'utf8');
const userUnit = readFileSync(fileURLToPath(new URL('../templates/webhook-wake.user.service', import.meta.url)), 'utf8');
const runtimeEnv = readFileSync(fileURLToPath(new URL('../templates/runtime.env.example', import.meta.url)), 'utf8');
const monitorTimer = readFileSync(fileURLToPath(new URL('../templates/monitor.timer', import.meta.url)), 'utf8');
const monitorService = readFileSync(fileURLToPath(new URL('../templates/monitor.service', import.meta.url)), 'utf8');
const userConfig = readFileSync(fileURLToPath(new URL('../templates/config.user.example.json', import.meta.url)), 'utf8');
const exampleSecret = readFileSync(fileURLToPath(new URL('../templates/canary.whs.example', import.meta.url)), 'utf8').trim();

describe('systemd specifier policy', () => {
  test('system unit does not use manager %h/%U for HOME or XDG_RUNTIME_DIR', () => {
    expect(systemUnit).not.toMatch(/Environment=HOME=%h/);
    expect(systemUnit).not.toMatch(/Environment=XDG_RUNTIME_DIR=\/run\/user\/%U/);
    expect(systemUnit).toMatch(/^EnvironmentFile=\/etc\/webhook-wake\/runtime\.env$/m);
    expect(systemUnit).not.toMatch(/^EnvironmentFile=-/m);
    expect(systemUnit).toMatch(/ProtectHome=read-only/);
  });

  test('operator runtime.env example supplies a non-root context without secrets', () => {
    expect(runtimeEnv).toMatch(/^HOME=\/home\/ops$/m);
    expect(runtimeEnv).toMatch(/^USER=ops$/m);
    expect(runtimeEnv).toMatch(/^XDG_RUNTIME_DIR=\/run\/user\/1000$/m);
    expect(runtimeEnv).not.toMatch(/\/root/);
    expect(systemUnit).toMatch(/^User=ops$/m);
    expect(systemUnit).toMatch(/^StateDirectory=webhook-wake$/m);
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
    expect(userUnit).toMatch(/StateDirectory=webhook-wake/);
    expect(userUnit).toMatch(/ReadWritePaths=%h\/\.local\/state\/webhook-wake/);
  });

  test('monitor timer Unit matches the documented install rename', () => {
    expect(monitorTimer).toMatch(/^Unit=webhook-wake-monitor\.service$/m);
    expect(monitorService).toContain('webhook-wake-monitor.service');
    expect(userConfig).toContain('/home/ops/.local/state/webhook-wake/dedup.json');
    expect(exampleSecret).toMatch(/^whs_/);
    expect(exampleSecret).not.toMatch(/^whs_[0-9a-f]{64}$/);
  });

  test('monitor service uses DynamicUser, StateDirectory, and network-online Wants', () => {
    expect(monitorService).toMatch(/^After=network-online\.target$/m);
    expect(monitorService).toMatch(/^Wants=network-online\.target$/m);
    expect(monitorService).toMatch(/^DynamicUser=yes$/m);
    expect(monitorService).not.toMatch(/^User=nobody$/m);
    expect(monitorService).toMatch(/^StateDirectory=webhook-wake-monitor$/m);
    expect(monitorService).toMatch(/STATE_FILE=\/var\/lib\/webhook-wake-monitor\/state/);
    expect(monitorService).toMatch(/^ExecStart=\/usr\/local\/bin\/webhook-wake-monitor\.sh$/m);
    expect(monitorService).toMatch(/ALERT_BIN=\/usr\/local\/bin\/webhook-wake-alert/);
  });
});
