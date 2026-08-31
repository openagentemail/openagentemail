import { readFile, writeFile } from 'node:fs/promises';
import { CorrelationStore, createIntent, requestFingerprint } from '../../src/correlation-store.js';
import { createOrAdopt, withMarker } from '../../src/retry.js';
import type { OaeTask } from '../../src/openagentemail.js';

const [mode, directory, serverPath] = process.argv.slice(2);
if (!mode || !directory || !serverPath) throw new Error('usage: reconcile-child <create|recover> <state-dir> <server.json>');
const base = { requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'non-secret approval request' };
const correlationId = '88888888-8888-4888-8888-888888888888';
const record = createIntent({ framework: 'neutral', correlationId, operationKey: 'process/reconciliation', requestFingerprint: requestFingerprint(base), expectedParticipants: { requester: base.requester, responder: base.responder }, frameworkStateRef: 'checkpoint.sqlite', approvalItemKey: null });
const request = { to: base.responder, subject: withMarker(record, base.subject), body: base.body };
type Server = { creates: number; hidePostRestartLists: number; task: OaeTask | null };
const readServer = async (): Promise<Server> => JSON.parse(await readFile(serverPath, 'utf8')) as Server;
const writeServer = async (server: Server) => writeFile(serverPath, JSON.stringify(server), 'utf8');
const makeTask = (): OaeTask => ({ id: 'task-1', from: base.requester, to: base.responder, subject: request.subject, state: 'submitted', createdAt: 'x', updatedAt: 'x', messages: [{ id: 'root-1', from: base.requester, to: base.responder, subject: request.subject, date: 'x', state: 'submitted', body: base.body }] });

if (mode === 'advance') {
  const store = new CorrelationStore(directory);
  const loaded = await store.load(correlationId);
  const stamp = process.argv[5] ?? '2026-01-01T00:00:01.000Z';
  const { transition } = await import('../../src/correlation-store.js');
  await store.save(transition(loaded, 'create-attempted', { createAttemptedAt: stamp }, stamp));
} else if (mode === 'create') {
  const store = new CorrelationStore(directory);
  await store.save(record);
  await createOrAdopt(store, { create: async () => { const server = await readServer(); server.creates += 1; server.task = makeTask(); await writeServer(server); throw new Error('simulated connection loss after accepted create'); }, list: async () => [] }, record, request).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'simulated connection loss after accepted create') throw error;
  });
} else if (mode === 'recover') {
  const store = new CorrelationStore(directory);
  const restarted = await store.load(correlationId);
  await createOrAdopt(store, { create: async () => { throw new Error('recovery must never create'); }, list: async () => { const server = await readServer(); if (server.hidePostRestartLists > 0) { server.hidePostRestartLists -= 1; await writeServer(server); return []; } return server.task ? [server.task] : []; } }, restarted, request, 2);
} else throw new Error(`unknown mode ${mode}`);
