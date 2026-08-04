#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.ts';
import { runConnect } from './connect.ts';
import { runDemo } from './demo.ts';
import { ClackPromptAdapter } from './prompts.ts';
import { Reporter } from './reporter.ts';
import { CliError, EXIT, type PromptAdapter } from './types.ts';
import { runWizard } from './wizard.ts';
import { packageVersion } from './version.ts';

const HELP = `@openagentemail/setup

Usage:
  npx -y @openagentemail/setup
  npx -y @openagentemail/setup connect --api-url <url> --token <token> --clients <ids> --yes --json [--verify]
  npx -y @openagentemail/setup demo --yes --json [--teardown]

Options:
  --api-url <url>       openagent.email API base URL
  --token <token>       identity token or admin key (never printed or saved in state)
  --clients <ids>       comma-separated client ids, or "none"
  --name <name>         display name when an admin key creates a scoped identity
  --yes                 non-interactive mode
  --json                emit one JSON result on stdout (requires --yes)
  --verify              perform an MCP initialize + tools/list handshake
  --no-fetch            use bundled recommendations without checking for updates
  --teardown            remove the local demo and its Docker volumes
  --help                show this help
  --version             show the package version`;

type RunDependencies = {
  prompts?: PromptAdapter;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
};

export async function runCli(
  argv: string[],
  dependencies: RunDependencies = {},
): Promise<number> {
  const wantsJson = argv.includes('--json');
  const reporter = new Reporter(wantsJson, dependencies.stdout, dependencies.stderr);
  try {
    const options = parseArgs(argv);
    if (options.help) {
      (dependencies.stdout ?? process.stdout).write(`${HELP}\n`);
      return EXIT.OK;
    }
    if (options.version) {
      (dependencies.stdout ?? process.stdout).write(`${packageVersion.version}\n`);
      return EXIT.OK;
    }
    if (options.yes && !options.command) {
      throw new CliError('--yes requires either the connect or demo command');
    }

    const prompts = dependencies.prompts ?? new ClackPromptAdapter();
    if (!options.yes) prompts.intro('@openagentemail/setup');

    const result = options.command === 'connect'
      ? await runConnect(options, prompts, reporter)
      : options.command === 'demo'
        ? await runDemo(options, prompts, reporter)
        : await runWizard(options, prompts, reporter);

    reporter.finish({ ok: true, ...result });
    if (!options.yes) prompts.outro('Setup complete.');
    return EXIT.OK;
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError(error instanceof Error ? error.message : String(error));
    if (!wantsJson) {
      (dependencies.stderr ?? process.stderr).write(`Error: ${cliError.message}\n`);
    }
    reporter.finish({ ok: false, configuredClients: [], error: cliError.message });
    return cliError.exitCode;
  }
}

const entrypoint = process.argv[1];
const isEntrypoint = entrypoint &&
  existsSync(entrypoint) &&
  realpathSync(entrypoint) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}
