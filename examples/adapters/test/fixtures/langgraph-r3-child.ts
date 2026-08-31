import { join } from 'node:path';
import { CorrelationStore, createIntent, requestFingerprint } from '../../src/correlation-store.js';
import type { OaeTask } from '../../src/openagentemail.js';
import { inspectLangGraphFinal, langGraphApprovalKey, langGraphOperationKey, pauseLangGraph, resumeLangGraph } from '../../src/langgraph.js';
import { withMarker } from '../../src/retry.js';
import { FixtureJsonStore } from '../../src/fixture-store.js';

const [mode, directory, decision, suppliedThreadId, suppliedCorrelationId] = process.argv.slice(2);
if (!['pause', 'decide', 'resume'].includes(mode ?? '') || !directory || (decision !== 'approved' && decision !== 'rejected')) throw new Error('usage: langgraph-r3-child <pause|decide|resume> <directory> <approved|rejected>');
const threadId = suppliedThreadId ?? 'r3-thread-000000000001'; const correlationId = suppliedCorrelationId ?? '77777777-7777-4777-8777-777777777777'; const requester = 'requester@example.test'; const responder = 'responder@example.test'; const subject = 'R3 LangGraph approval'; const workflow = 'raw-workflow-r3';
const correlationStore = new CorrelationStore(join(directory, 'correlation')); const taskStore = new FixtureJsonStore<OaeTask>(directory, 'oae-task.json');
async function saveTask(task: OaeTask): Promise<void> { await taskStore.save(task); }
async function loadTask(): Promise<OaeTask> { return taskStore.load(); }
const oae = {
  create: async (request: { to: string; subject: string; body: string }) => { const task: OaeTask = { id: 'r3-task-1', from: requester, to: request.to, subject: request.subject, state: 'submitted', createdAt: '2026-02-03T00:00:00.000Z', updatedAt: '2026-02-03T00:00:00.000Z', messages: [{ id: 'root-1', from: requester, to: request.to, subject: request.subject, date: '2026-02-03T00:00:00.000Z', state: 'submitted', body: request.body }] }; await saveTask(task); return task; },
  list: async () => [await loadTask()], get: async () => loadTask(),
  inputRequired: async (id: string, body: string) => { const task = await loadTask(); if (task.id !== id) throw new Error('task mismatch'); const next: OaeTask = { ...task, state: 'input-required', updatedAt: '2026-02-03T00:00:01.000Z', messages: [...task.messages, { id: 'input-1', from: requester, to: responder, subject: task.subject, date: '2026-02-03T00:00:01.000Z', state: 'input-required', body }] }; await saveTask(next); return next; },
};
if (mode === 'pause') {
  const canonical = { requester, responder, subject, body: workflow }; const record = createIntent({ framework: 'langgraph', correlationId, operationKey: langGraphOperationKey(threadId), requestFingerprint: requestFingerprint(canonical), expectedParticipants: { requester, responder }, frameworkStateRef: 'langgraph-checkpoints.sqlite', approvalItemKey: langGraphApprovalKey(threadId), now: '2026-02-03T00:00:00.000Z' }); await correlationStore.save(record); const awaiting = await pauseLangGraph({ directory, threadId, workflow, record, correlationStore, oae }); await new FixtureJsonStore(directory, 'pause-result.json').save({ phase: awaiting.phase, taskId: awaiting.taskId, threadId, operationKey: awaiting.operationKey, inputEvents: (await loadTask()).messages.filter((m) => m.state === 'input-required').length });
} else if (mode === 'decide') {
  const task = await loadTask(); const record = await correlationStore.load(correlationId); const next: OaeTask = { ...task, state: 'completed', updatedAt: '2026-02-03T00:00:02.000Z', messages: [...task.messages, { id: 'terminal-1', from: responder, to: requester, subject: withMarker(record, subject), date: '2026-02-03T00:00:02.000Z', state: 'completed', body: decision, result: { decision } }], result: { decision } }; await saveTask(next);
} else {
  const record = await correlationStore.load(correlationId); const result = await resumeLangGraph({ directory, threadId, record, correlationStore, task: await loadTask() }); const final = await inspectLangGraphFinal(directory, threadId, result); const task = await loadTask(); await new FixtureJsonStore(directory, 'result.json').save({ phase: result.phase, taskId: result.taskId, threadId, operationKey: result.operationKey, decision: final.decision, effects: final.effects, checkpointId: final.checkpointId, finalStateFingerprint: final.finalStateFingerprint, effectObservationFingerprint: final.effectObservationFingerprint, inputEvents: task.messages.filter((m) => m.state === 'input-required').length });
}
