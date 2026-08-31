import { access, readFile, writeFile } from 'node:fs/promises';
import { CorrelationStore, type CorrelationRecord } from '../../src/correlation-store.js';

const [directory, candidatePath, readyPath, goPath, resultPath] = process.argv.slice(2);
if (!directory || !candidatePath || !readyPath || !goPath || !resultPath) throw new Error('usage: race-child <state-dir> <candidate.json> <ready> <go> <result>');
const candidate = JSON.parse(await readFile(candidatePath, 'utf8')) as CorrelationRecord;
await writeFile(readyPath, 'ready\n', { mode: 0o600 });
for (;;) {
  try { await access(goPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
}
try {
  await new CorrelationStore(directory).save(candidate);
  await writeFile(resultPath, JSON.stringify({ ok: true, phase: candidate.phase }), { mode: 0o600 });
} catch (error) {
  await writeFile(resultPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), { mode: 0o600 });
  process.exitCode = 1;
}
