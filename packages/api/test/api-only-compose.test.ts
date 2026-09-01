import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { expect, test } = await import('bun:test');

const repoDir = join(import.meta.dir, '..', '..', '..');
const compose = readFileSync(join(repoDir, 'compose.api-only.yaml'), 'utf8');
const envExample = readFileSync(join(repoDir, '.env.api-only.example'), 'utf8');
const readme = readFileSync(join(repoDir, 'README.md'), 'utf8');

test('#70 API-only Compose keeps the internal API and storage contracts project-scoped', () => {
  expect(compose).toContain('name: openagentemail');
  expect(compose).not.toMatch(/^\s*container_name:/m);
  expect(compose).toMatch(/^\s*PORT: 3100$/m);
  expect(compose).toContain('- "${API_BIND:-127.0.0.1}:${API_PORT:-3100}:3100"');
  expect(compose).toMatch(/healthcheck:\n\s+test: .*localhost:3100\/healthz/);
  expect(compose).not.toMatch(/healthcheck:\n\s+test: .*API_PORT/);
  expect(compose).toMatch(/^\s*- api-data:\/app\/data$/m);
  expect(compose).toMatch(/^volumes:\n\s{2}api-data:\s*$/m);
  expect(compose).not.toContain('EXTERNAL_PORT');
});

test('#70 API-only docs require unique projects and host ports for two instances', () => {
  expect(readme).toContain('docker compose -p oae-alpha --env-file .env.alpha -f compose.api-only.yaml up -d');
  expect(readme).toContain('docker compose -p oae-beta  --env-file .env.beta  -f compose.api-only.yaml up -d');
  expect(readme).toContain('API_PORT=3100 in .env.alpha and API_PORT=3101 in .env.beta');
  expect(readme).toContain('oae-alpha_api-data');
  expect(readme).toContain('oae-beta_api-data');
  expect(readme).toContain('COMPOSE_PROJECT_NAME');
  expect(envExample).toContain('different API_PORT');
  expect(envExample).toContain('unique `docker compose -p`');
  expect(envExample).toContain('unique COMPOSE_PROJECT_NAME');
  expect(envExample).toContain('container port stays fixed at 3100');
});
