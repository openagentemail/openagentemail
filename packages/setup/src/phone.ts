import type { Reporter } from './reporter.ts';
import { CliError, type PromptAdapter } from './types.ts';

export type PhoneDevice = {
  username: string;
  password: string;
  serverUrl: string;
  topics: { userAlerts: string; userLow: string };
};

type PhoneDependencies = {
  fetcher?: typeof fetch;
};

function endpoint(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/v1/notify/devices`;
}

export function normalizePublicNotifyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('The public ntfy URL must be a valid https:// URL.');
  }
  if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new CliError('The public ntfy URL must be an https:// origin without a path, query, or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

function validDevice(value: unknown): value is PhoneDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  const topics = device.topics as Record<string, unknown> | undefined;
  return (
    typeof device.username === 'string' &&
    typeof device.password === 'string' &&
    typeof device.serverUrl === 'string' &&
    !!topics &&
    typeof topics.userAlerts === 'string' &&
    typeof topics.userLow === 'string'
  );
}

export async function createPhoneDevice(
  apiUrl: string,
  adminKey: string,
  publicUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<PhoneDevice> {
  let response: Response;
  try {
    response = await fetcher(endpoint(apiUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError('Could not reach the server to create the phone reader.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError('Phone pairing needs an admin key from API_KEYS, not an identity token.');
  }
  if (response.status === 409) {
    throw new CliError('NOTIFY_PUBLIC_URL is not active yet. Set it in .env and restart the full stack before pairing.');
  }
  if (!response.ok) throw new CliError(`Could not create the phone reader (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (!validDevice(body)) throw new CliError('The server returned an invalid phone reader response.');
  return body;
}

/** Optional wizard branch: no public URL or a skipped confirmation changes nothing. */
export async function offerPhonePairing(
  prompts: PromptAdapter,
  reporter: Reporter,
  dependencies: PhoneDependencies = {},
): Promise<void> {
  if (!await prompts.confirm('Set up phone notifications now?', false)) return;
  if (!await prompts.confirm('Do you have a public HTTPS hostname for ntfy?', false)) {
    reporter.info('Phone notifications need a public HTTPS hostname. Server-side notifications still work without one.');
    return;
  }

  const publicUrl = normalizePublicNotifyUrl(await prompts.text(
    'Public ntfy HTTPS URL',
    'https://ntfy.example.com',
    true,
  ));
  reporter.info(
    `Before pairing, set NOTIFY_PUBLIC_URL=${publicUrl} in the server .env, then run: docker compose down && docker compose up -d`,
  );
  reporter.info('Do this before opening the ntfy app. A wrong base URL can receive messages but never ring the phone.');
  if (!await prompts.confirm('Has the stack restarted with this exact public URL?', false)) return;

  const apiUrl = await prompts.text('openagent.email API URL', 'http://localhost:3100', true);
  const adminKey = await prompts.password('Admin key from API_KEYS (used once to create the phone reader)');
  const device = await createPhoneDevice(apiUrl, adminKey, publicUrl, dependencies.fetcher);

  // This is intentionally the only place the password is displayed. It is not
  // stored in setup state, client configuration, or a QR code/scrollback image.
  reporter.info('\nPhone reader created — save these details now:');
  reporter.info(`  Server: ${device.serverUrl}`);
  reporter.info(`  Username: ${device.username}`);
  reporter.info(`  Password: ${device.password}`);
  reporter.info(`  Urgent topic (ring): ${device.topics.userAlerts}`);
  reporter.info(`  Low topic (silent): ${device.topics.userLow}`);
  reporter.info('In the ntfy app, sign in to this server with this reader, then subscribe to both printed topics.');
  reporter.info('These credentials stay in terminal scrollback; do not paste them into chat or tickets.');
}

