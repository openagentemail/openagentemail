import { isCredentialShaped } from './correlation-store.js';
import { OaeClient, safeOaeBaseUrl } from './openagentemail.js';

export type RuntimeParticipants = { requester: { address: string; client: OaeClient }; responder: { address: string; client: OaeClient } };
/** Explicit caller-side wiring for a real OAE deployment; it performs no identity/bootstrap operation or network I/O at construction. */
export function createRuntimeParticipants(environment: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch): RuntimeParticipants {
  const baseUrl = safeOaeBaseUrl(required(environment, 'OPENAGENTEMAIL_API_URL'));
  const requester = address(required(environment, 'OAE_REQUESTER_EMAIL'), 'OAE_REQUESTER_EMAIL'); const responder = address(required(environment, 'OAE_RESPONDER_EMAIL'), 'OAE_RESPONDER_EMAIL');
  if (requester === responder) throw new Error('OAE participants must be distinct');
  const requesterToken = token(required(environment, 'OAE_REQUESTER_TOKEN')); const responderToken = token(required(environment, 'OAE_RESPONDER_TOKEN'));
  if (requesterToken === responderToken) throw new Error('OAE participant tokens must be distinct');
  return { requester: { address: requester, client: new OaeClient({ baseUrl, token: requesterToken, ...(fetch ? { fetch } : {}) }) }, responder: { address: responder, client: new OaeClient({ baseUrl, token: responderToken, ...(fetch ? { fetch } : {}) }) } };
}
function required(environment: NodeJS.ProcessEnv, name: string): string { const value = environment[name]; if (!value) throw new Error(`missing ${name}`); return value; }
function address(value: string, name: string): string { if (value !== value.toLowerCase() || !/^[^@\s]+@[^@\s]+$/.test(value) || isCredentialShaped(value)) throw new Error(`${name} must be canonical lowercase email`); return value; }
function token(value: string): string { if (/\r|\n/.test(value)) throw new Error('OAE token is unsafe'); return value; }
