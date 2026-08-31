import { formatExplicitLiveResult, runExplicitLiveExample } from './openai-agents.js';

const result = await runExplicitLiveExample(process.argv.slice(2).join(' ') || 'explicit live example');
process.stdout.write(formatExplicitLiveResult(result));
