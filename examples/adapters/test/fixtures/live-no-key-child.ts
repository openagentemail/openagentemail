import { runExplicitLiveExample } from '../../src/openai-agents.js';
const status = await runExplicitLiveExample('no-key-safe-input');
if (status.status !== 'skipped-no-key') throw new Error('live mode did not skip without key');
process.stdout.write(`${status.status}\n`);
