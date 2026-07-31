import type { CliResult } from './types.ts';

export class Reporter {
  readonly warnings: string[] = [];

  constructor(
    readonly json: boolean,
    private readonly stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
    private readonly stderr: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
  ) {}

  info(message: string): void {
    const target = this.json ? this.stderr : this.stdout;
    target.write(`${message}\n`);
  }

  warn(message: string): void {
    this.warnings.push(message);
    this.stderr.write(`Warning: ${message}\n`);
  }

  finish(result: Omit<CliResult, 'warnings'>): void {
    const payload: CliResult = { ...result, warnings: [...this.warnings] };
    if (this.json) {
      this.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  }
}
