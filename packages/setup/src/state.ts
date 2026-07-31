import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SetupState = {
  stage: string;
  apiUrl?: string;
  updatedAt: string;
};

export function setupStatePath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(configHome, 'openagentemail', 'setup-state.json');
}

export function isSetupState(value: unknown): value is SetupState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.stage === 'string' &&
    typeof state.updatedAt === 'string' &&
    (state.apiUrl === undefined || typeof state.apiUrl === 'string')
  );
}

export async function readSetupState(path = setupStatePath()): Promise<SetupState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isSetupState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSetupState(
  state: Omit<SetupState, 'updatedAt'>,
  path = setupStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  const payload: SetupState = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function clearSetupState(path = setupStatePath()): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
