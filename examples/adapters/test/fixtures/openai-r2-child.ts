import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CorrelationStore, createIntent, requestFingerprint } from '../../src/correlation-store.js';
import type { OaeTask } from '../../src/openagentemail.js';
import { buildScriptedApprovalAgent, pauseWithScriptedModel, resumeAuthoritativeOaeRun, RunStateStore } from '../../src/openai-agents.js';
import { createOrAdopt, requestInputOrReconcile, withMarker } from '../../src/retry.js';

const [mode, directory, decision] = process.argv.slice(2);
if (!['pause', 'decide', 'resume'].includes(mode ?? '') || !directory || (decision !== 'approved' && decision !== 'rejected')) throw new Error('usage: openai-r2-child <pause|decide|resume> <directory> <approved|rejected>');
const correlationId = '33333333-3333-4333-8333-333333333333'; const requester = 'requester@example.test'; const responder = 'responder@example.test';
const stateStore = new RunStateStore(directory); const correlationStore = new CorrelationStore(join(directory, 'correlation')); const taskPath = join(directory, 'oae-task.json'); const receiptStore = new RunStateStore(directory, 'tool-receipt.json');
async function saveTask(task: OaeTask): Promise<void> { await writeFile(taskPath, JSON.stringify(task), { mode: 0o600 }); }
async function loadTask(): Promise<OaeTask> { return JSON.parse(await readFile(taskPath, 'utf8')) as OaeTask; }
function fakeOae() {
  return {
    create: async (request: { to: string; subject: string; body: string }) => { const task: OaeTask = { id: 'r2-task-1', from: requester, to: request.to, subject: request.subject, state: 'submitted', createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', messages: [{ id: 'root-1', from: requester, to: request.to, subject: request.subject, date: '2026-02-02T00:00:00.000Z', state: 'submitted', body: request.body }] }; await saveTask(task); return task; },
    list: async () => [await loadTask()], get: async () => loadTask(),
    inputRequired: async (id: string, body: string) => { const task = await loadTask(); if (task.id !== id) throw new Error('fake OAE task mismatch'); const next: OaeTask = { ...task, state: 'input-required', updatedAt: '2026-02-02T00:00:01.000Z', messages: [...task.messages, { id: 'input-1', from: requester, to: responder, subject: task.subject, date: '2026-02-02T00:00:01.000Z', state: 'input-required', body }] }; await saveTask(next); return next; },
  };
}
if (mode === 'pause') {
  const graph = buildScriptedApprovalAgent(`${decision}-final`); const paused = await pauseWithScriptedModel(graph); await stateStore.save(paused.state.toString());
  const canonical = { requester, responder, subject: 'R2 approval', body: 'non-secret R2 request' }; const intent = createIntent({ framework: 'openai-agents', correlationId, operationKey: 'r2/fresh-process', requestFingerprint: requestFingerprint(canonical), expectedParticipants: { requester, responder }, frameworkStateRef: 'run-state.json', approvalItemKey: paused.approvalKey, now: '2026-02-02T00:00:00.000Z' });
  await correlationStore.save(intent); const adopted = await createOrAdopt(correlationStore, fakeOae(), intent, { to: responder, subject: withMarker(intent, canonical.subject), body: canonical.body }); const awaiting = await requestInputOrReconcile(correlationStore, fakeOae(), adopted);
  await writeFile(join(directory, 'pause-result.json'), JSON.stringify({ taskId: awaiting.taskId, phase: awaiting.phase, approvals: 1, executions: graph.executions.count }), { mode: 0o600 });
} else if (mode === 'decide') {
  const task = await loadTask(); if (task.state !== 'input-required') throw new Error('fake OAE must accept exactly one input-required event before a decision'); const next: OaeTask = { ...task, state: 'completed', updatedAt: '2026-02-02T00:00:02.000Z', messages: [...task.messages, { id: 'terminal-1', from: responder, to: requester, subject: task.subject, date: '2026-02-02T00:00:02.000Z', state: 'completed', body: decision, result: { decision } }], result: { decision } }; await saveTask(next);
} else {
  const record = await correlationStore.load(correlationId); const task = await loadTask(); const graph = buildScriptedApprovalAgent(`${decision}-final`); const result = await resumeAuthoritativeOaeRun({ agent: graph.agent, stateStore, receiptStore, correlationStore, record, task, executionCount: () => graph.executions.count });
  const persisted = await stateStore.load(); const restored = await (await import('@openai/agents')).RunState.fromString(graph.agent, persisted); const receipt = JSON.parse(await receiptStore.load()) as { finalStateHash: string; executions: number }; await writeFile(join(directory, 'result.json'), JSON.stringify({ decision, phase: result.phase, taskId: result.taskId, executions: receipt.executions, final: `${decision}-final`, pendingInterruptions: restored.getInterruptions().length, receipt: receipt.finalStateHash.length }), { mode: 0o600 });
}
