import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadScenario, runScenario, sanitizeFailure, writeScenarioArtifact } from './scenario-runner.js';

const path = process.argv[2];
if (!path) throw new Error('usage: scenario-cli <scenario.yaml>');
const output = await mkdtemp(join(tmpdir(), `oae-scenario-${basename(path, '.yaml')}-`));
try { const scenario = await loadScenario(path); const result = await runScenario({ scenario, environment: process.env, stateDirectory: output }); await writeScenarioArtifact(output, 'success.json', result); process.stdout.write(`${JSON.stringify({ ...result, artifact: join(output, 'success.json') })}\n`); }
catch (error) { const failure = sanitizeFailure(error); await writeScenarioArtifact(output, 'failure.json', failure); process.stdout.write(`${JSON.stringify({ ...failure, artifact: join(output, 'failure.json') })}\n`); process.exitCode = 2; }
