import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const caddy = readFileSync(fileURLToPath(new URL('../templates/Caddyfile', import.meta.url)), 'utf8');
const nginx = readFileSync(fileURLToPath(new URL('../templates/nginx.conf', import.meta.url)), 'utf8');

describe('public proxy route contract', () => {
  test('Caddy keeps /health and /hooks and does not publish /ready', () => {
    expect(caddy).toMatch(/handle \/health/);
    expect(caddy).toMatch(/handle \/hooks\/\*/);
    expect(caddy).toMatch(/respond 404/);
    expect(caddy).not.toMatch(/handle \/ready/);
    expect(caddy).not.toMatch(/reverse_proxy 127\.0\.0\.1:8787\n}/);
  });

  test('nginx keeps /health and /hooks and does not publish /ready', () => {
    expect(nginx).toMatch(/location = \/health/);
    expect(nginx).toMatch(/location \/hooks\//);
    expect(nginx).toMatch(/return 404/);
    expect(nginx).not.toMatch(/location \/ready/);
    expect(nginx).not.toMatch(/location \/ \{\s*proxy_pass/);
  });
});
