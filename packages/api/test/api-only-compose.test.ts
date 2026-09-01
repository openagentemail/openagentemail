import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { expect, test } = await import('bun:test');

const repoDir = join(import.meta.dir, '..', '..', '..');
const compose = readFileSync(join(repoDir, 'compose.api-only.yaml'), 'utf8');
const envExample = readFileSync(join(repoDir, '.env.api-only.example'), 'utf8');
const readme = readFileSync(join(repoDir, 'README.md'), 'utf8');
const composeLines = new Set(compose.split('\n').map((line) => line.trim()));
const apiOnlyIntro = readme.split('## Using your own mail server', 2)[1]!.split('To run multiple API-only instances', 1)[0]!;
const multiInstanceDocs = readme.split('To run multiple API-only instances', 2)[1]!.split('## Read mail', 1)[0]!;

function topLevelSection(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\S/.test(line));
  return lines.slice(start, endOffset < 0 ? undefined : start + 1 + endOffset).join('\n');
}

function hasStaticProjectVolume(source: string): boolean {
  const volumes = topLevelSection(source, 'volumes');
  const entries = [...volumes.matchAll(/^  ([^\s:#][^:]*):(?:\s*(.*))?$/gm)]
    .map((match) => ({ key: match[1], value: match[2] ?? '' }));
  return entries.length === 1 &&
    entries[0]!.key === 'api-data' &&
    entries[0]!.value === '' &&
    !/\$\{|^\s+(?:name|external):/m.test(volumes);
}

function requiresIndependentInstanceSecrets(source: string): boolean {
  const candidates = [
    ...source.split('\n'),
    ...source.replace(/\s+/g, ' ').split(/[.!?]/),
  ];
  return candidates.some((candidate) =>
    /\beach (?:instance|file|copy)\b|\bper[- ]instance\b/i.test(candidate) &&
    /\bseparate\b|\bindependently generated\b/i.test(candidate) &&
    /\bAPI_KEYS\b/.test(candidate) &&
    /\bTASK_SIGNING_SECRET\b/.test(candidate));
}

test('#70 API-only Compose keeps the internal API and storage contracts project-scoped', () => {
  expect(composeLines).toContain('name: openagentemail');
  expect(compose).not.toMatch(/^\s*container_name:/m);
  expect(composeLines).toContain('PORT: 3100');
  expect(composeLines).toContain('- "${API_BIND:-127.0.0.1}:${API_PORT:-3100}:3100"');
  expect(compose).toMatch(/healthcheck:\n\s+test: .*localhost:3100\/healthz/);
  expect(composeLines).toContain('- api-data:/app/data');
  expect(compose).not.toContain('EXTERNAL_PORT');

  expect(hasStaticProjectVolume(compose)).toBe(true);
});

test('#70 API-only volume regression rejects renamed, interpolated, external, and shared-volume canaries', () => {
  const replaceVolume = (replacement: string) => compose.replace('\n  api-data:\n', `\n${replacement}\n`);
  expect({
    live: hasStaticProjectVolume(compose),
    renamed: hasStaticProjectVolume(replaceVolume('  shared-data:')),
    interpolated: hasStaticProjectVolume(replaceVolume('  ${VOLUME_NAME}:')),
    blockName: hasStaticProjectVolume(replaceVolume('  api-data:\n    name: shared')),
    blockExternal: hasStaticProjectVolume(replaceVolume('  api-data:\n    external: true')),
    inlineName: hasStaticProjectVolume(replaceVolume('  api-data: { name: shared }')),
    inlineExternal: hasStaticProjectVolume(replaceVolume('  api-data: { external: true }')),
  }).toEqual({
    live: true,
    renamed: false,
    interpolated: false,
    blockName: false,
    blockExternal: false,
    inlineName: false,
    inlineExternal: false,
  });
});

test('#70 API-only docs keep two projects, ports, and secrets isolated outside the repository', () => {
  expect(multiInstanceDocs).toMatch(/mkdir -p \.\.\/oae-api-only-env/);
  expect(multiInstanceDocs).toContain('chmod 600 ../oae-api-only-env/*.env');
  expect(multiInstanceDocs).toMatch(/-p oae-alpha --env-file \.\.\/oae-api-only-env\/alpha\.env/);
  expect(multiInstanceDocs).toMatch(/-p oae-beta\s+--env-file \.\.\/oae-api-only-env\/beta\.env/);
  expect(multiInstanceDocs).toMatch(/API_PORT=3100.*API_PORT=3101/);
  expect(requiresIndependentInstanceSecrets(multiInstanceDocs)).toBe(true);
  expect(requiresIndependentInstanceSecrets(envExample)).toBe(true);
  const reusedSecretsCanary = multiInstanceDocs
    .replace(/\bseparate\b/gi, 'shared')
    .replace(/\bindependently generated\b/gi, 'reused');
  expect(requiresIndependentInstanceSecrets(reusedSecretsCanary)).toBe(false);
  expect(multiInstanceDocs).toContain('outside the repository');
  expect(multiInstanceDocs).toContain('unique Compose project');
  expect(multiInstanceDocs).toContain('COMPOSE_PROJECT_NAME');
  expect(multiInstanceDocs).not.toMatch(/--env-file \.env\.(?:alpha|beta)\b/);
  for (const token of ['outside the repository', '0600', 'different API_PORT', 'API_KEYS', 'TASK_SIGNING_SECRET', 'COMPOSE_PROJECT_NAME']) {
    expect(envExample).toContain(token);
  }
  expect(apiOnlyIntro).toContain('compose.yaml');
  expect(apiOnlyIntro).toContain('must not');
  expect(apiOnlyIntro).toContain('different `-p`');
  expect(compose).toMatch(/compose\.yaml[\s\S]*MUST use an explicitly different -p \/ COMPOSE_PROJECT_NAME/);
});
