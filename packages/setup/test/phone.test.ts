import { describe, expect, test } from 'bun:test';
import { createPhoneDevice, normalizePublicNotifyUrl, offerPhonePairing } from '../src/phone.ts';
import { Reporter } from '../src/reporter.ts';
import type { PromptAdapter, SelectOption } from '../src/types.ts';

function sink() {
  let value = '';
  return {
    stream: { write(chunk: string | Uint8Array) { value += String(chunk); return true; } },
    value: () => value,
  };
}

class PhonePrompts implements PromptAdapter {
  readonly messages: string[] = [];

  constructor(private readonly confirms: boolean[]) {}

  intro() {}
  outro() {}

  async confirm(message: string): Promise<boolean> {
    this.messages.push(message);
    const value = this.confirms.shift();
    if (value === undefined) throw new Error(`No confirm answer for: ${message}`);
    return value;
  }

  async select(_message: string, _options: SelectOption[]): Promise<string> { throw new Error('unexpected select'); }
  async multiselect(): Promise<string[]> { throw new Error('unexpected multiselect'); }
  async text(): Promise<string> { throw new Error('unexpected text'); }
  async password(): Promise<string> { throw new Error('unexpected password'); }
}

describe('phone pairing API client', () => {
  test('accepts only a bare public HTTPS origin', () => {
    expect(normalizePublicNotifyUrl('https://ntfy.example.com/')).toBe('https://ntfy.example.com');
    expect(() => normalizePublicNotifyUrl('http://ntfy.example.com')).toThrow('https://');
    expect(() => normalizePublicNotifyUrl('https://ntfy.example.com/path')).toThrow('origin');
  });

  test('sends the expected URL but never needs to retain the admin key', async () => {
    let request: { url: string; headers?: HeadersInit; body?: string } | undefined;
    const device = {
      username: 'phone-x7k2', password: 'one-time-password', serverUrl: 'https://ntfy.example.com',
      topics: { userAlerts: 'user-alerts-x7k2', userLow: 'user-low-x7k2' },
    };
    const result = await createPhoneDevice(
      'http://localhost:3100',
      'admin-secret',
      'https://ntfy.example.com',
      async (url, init) => {
        request = { url: String(url), headers: init?.headers, body: String(init?.body) };
        return new Response(JSON.stringify(device), { status: 201 });
      },
    );
    expect(result).toEqual(device);
    expect(request?.url).toBe('http://localhost:3100/v1/notify/devices');
    expect(request?.body).toBe('{"publicUrl":"https://ntfy.example.com"}');
    expect(request?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer admin-secret' }));
  });

  test('explains an active-URL mismatch without exposing the credential', async () => {
    const error = await createPhoneDevice(
      'http://localhost:3100',
      'admin-secret',
      'https://ntfy.example.com',
      async () => new Response('{"error":"notify_public_url_mismatch"}', { status: 409 }),
    ).catch((value) => value as Error);
    expect(error.message).toContain('NOTIFY_PUBLIC_URL');
    expect(error.message).not.toContain('admin-secret');
  });

  test('defaults to skipping phone setup without asking for a URL or admin key', async () => {
    const prompts = new PhonePrompts([false]);
    const output = sink();
    await offerPhonePairing(
      prompts,
      new Reporter(false, output.stream, sink().stream),
      { fetcher: async () => { throw new Error('the API must not be called'); } },
    );
    expect(prompts.messages).toEqual(['Set up phone notifications now?']);
    expect(output.value()).toBe('');
  });

  test('stops without credentials when no public HTTPS hostname exists', async () => {
    const prompts = new PhonePrompts([true, false]);
    const output = sink();
    await offerPhonePairing(
      prompts,
      new Reporter(false, output.stream, sink().stream),
      { fetcher: async () => { throw new Error('the API must not be called'); } },
    );
    expect(prompts.messages).toEqual([
      'Set up phone notifications now?',
      'Do you have a public HTTPS hostname for ntfy?',
    ]);
    expect(output.value()).toContain('Server-side notifications still work without one.');
  });
});
