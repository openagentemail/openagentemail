export const EXIT = {
  OK: 0,
  ERROR: 1,
  API_UNREACHABLE: 2,
  TOKEN_INVALID: 3,
  MCP_VERIFY_FAILED: 4,
  DOCKER_MISSING: 5,
  DEMO_TIMEOUT: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.ERROR,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export type CliResult = {
  ok: boolean;
  configuredClients: string[];
  address?: string;
  warnings: string[];
  error?: string;
};

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
};

export interface PromptAdapter {
  intro(title: string): void;
  outro(message: string): void;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  select(message: string, options: SelectOption[], initialValue?: string): Promise<string>;
  multiselect(
    message: string,
    options: SelectOption[],
    initialValues: string[],
  ): Promise<string[]>;
  text(message: string, initialValue?: string, required?: boolean): Promise<string>;
  password(message: string): Promise<string>;
}
