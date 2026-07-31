import { CliError } from './types.ts';

export type Command = 'connect' | 'demo';

export type CliOptions = {
  command?: Command;
  apiUrl?: string;
  token?: string;
  clients?: string[];
  name?: string;
  yes: boolean;
  json: boolean;
  verify: boolean;
  teardown: boolean;
  noFetch: boolean;
  help: boolean;
  version: boolean;
};

const VALUE_FLAGS = new Set([
  '--api-url',
  '--token',
  '--clients',
  '--name',
]);

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    yes: false,
    json: false,
    verify: false,
    teardown: false,
    noFetch: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('-')) {
      if (options.command || (arg !== 'connect' && arg !== 'demo')) {
        throw new CliError(`Unknown command or argument: ${arg}`);
      }
      options.command = arg;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--api-url') options.apiUrl = value;
      if (arg === '--token') options.token = value;
      if (arg === '--name') options.name = value;
      if (arg === '--clients') {
        options.clients = value === 'none'
          ? []
          : value.split(',').map((item) => item.trim()).filter(Boolean);
      }
      continue;
    }

    if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--teardown') options.teardown = true;
    else if (arg === '--no-fetch') options.noFetch = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else throw new CliError(`Unknown option: ${arg}`);
  }

  if (options.json && !options.yes) {
    throw new CliError('--json requires --yes so no prompt can block the caller');
  }
  if (options.teardown && options.command !== 'demo') {
    throw new CliError('--teardown is only valid with the demo command');
  }
  return options;
}
