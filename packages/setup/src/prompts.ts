import * as p from '@clack/prompts';
import { CliError, type PromptAdapter, type SelectOption } from './types.ts';

function valueOrCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    throw new CliError('Setup cancelled');
  }
  return value;
}

export class ClackPromptAdapter implements PromptAdapter {
  intro(title: string): void {
    p.intro(title);
  }

  outro(message: string): void {
    p.outro(message);
  }

  async confirm(message: string, initialValue = true): Promise<boolean> {
    return valueOrCancel(await p.confirm({ message, initialValue }));
  }

  async select(
    message: string,
    options: SelectOption[],
    initialValue?: string,
  ): Promise<string> {
    return valueOrCancel(await p.select({ message, options, initialValue })) as string;
  }

  async multiselect(
    message: string,
    options: SelectOption[],
    initialValues: string[],
  ): Promise<string[]> {
    return valueOrCancel(
      await p.multiselect({ message, options, initialValues, required: false }),
    ) as string[];
  }

  async text(message: string, initialValue = '', required = false): Promise<string> {
    return valueOrCancel(await p.text({
      message,
      initialValue,
      validate(value) {
        if (required && !value?.trim()) return 'This value is required.';
      },
    }));
  }

  async password(message: string): Promise<string> {
    return valueOrCancel(await p.password({
      message,
      mask: '*',
      validate(value) {
        if (!value) return 'A token is required.';
      },
    }));
  }
}
