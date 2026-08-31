import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, RunState, run, tool } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { CorrelationSafetyError, CorrelationStore, createIntent, requestFingerprint, transition, type CorrelationRecord } from '../src/correlation-store.js';
import type { OaeTask } from '../src/openagentemail.js';
import { applyAuthoritativeOaeDecision, applyDecision, approvalIdentity, buildScriptedApprovalAgent, pauseWithScriptedModel, restoreRunState, resumeAuthoritativeOaeRun, RunStateStore, selectApproval } from '../src/openai-agents.js';
import { inputBodyFor, resumeDecision, withMarker } from '../src/retry.js';
import { sanitizedTimeline } from '../src/sanitize.js';

function oaeIntent(approvalItemKey: string, correlationId = '22222222-2222-4222-8222-222222222222'): CorrelationRecord {
  const canonical = { requester: 'requester@example.test', responder: 'responder@example.test', subject: 'R2 approval', body: 'non-secret R2 request' };
  return createIntent({ framework: 'openai-agents', correlationId, operationKey: 'r2/approval', requestFingerprint: requestFingerprint(canonical), expectedParticipants: { requester: canonical.requester, responder: canonical.responder }, frameworkStateRef: 'run-state.json', approvalItemKey, now: '2026-02-01T00:00:00.000Z' });
}
function oaeRecord(approvalItemKey: string): CorrelationRecord {
  const intent = oaeIntent(approvalItemKey);
  const attempted = transition(intent, 'create-attempted', { createAttemptedAt: '2026-02-01T00:00:01.000Z' }, '2026-02-01T00:00:01.000Z');
  return transition(attempted, 'task-adopted', { taskId: 'r2-task-1' }, '2026-02-01T00:00:02.000Z');
}

function authoritativeTask(record: CorrelationRecord, result: unknown = { decision: 'approved' }): OaeTask {
  const subject = withMarker(record, 'R2 approval');
  const root = { id: 'root-1', from: record.expectedParticipants.requester, to: record.expectedParticipants.responder, subject, date: '2026-02-01T00:00:00.000Z', state: 'submitted' as const, body: 'non-secret R2 request' };
  const terminal = { id: 'terminal-1', from: record.expectedParticipants.responder, to: record.expectedParticipants.requester, subject, date: '2026-02-01T00:00:03.000Z', state: 'completed' as const, body: 'approved', result };
  return { id: 'r2-task-1', from: root.from, to: root.to, subject, state: 'completed', createdAt: root.date, updatedAt: terminal.date, messages: [root, terminal], result };
}

async function durableAwaiting(directory: string, approvalItemKey: string, correlationId?: string): Promise<{ store: CorrelationStore; record: CorrelationRecord }> {
  const store = new CorrelationStore(join(directory, 'correlation')); const intent = oaeIntent(approvalItemKey, correlationId); const attempted = transition(intent, 'create-attempted', { createAttemptedAt: '2026-02-01T00:00:01.000Z' }, '2026-02-01T00:00:01.000Z'); const adopted = transition(attempted, 'task-adopted', { taskId: 'r2-task-1' }, '2026-02-01T00:00:02.000Z'); const inputAttempt = transition(adopted, 'input-request-attempted', { inputEvidence: requestFingerprint({ taskId: 'r2-task-1', body: inputBodyFor(adopted) }) }, '2026-02-01T00:00:03.000Z'); const awaiting = transition(inputAttempt, 'awaiting-input', {}, '2026-02-01T00:00:04.000Z');
  for (const record of [intent, attempted, adopted, inputAttempt, awaiting]) await store.save(record); return { store, record: awaiting };
}

async function durableStarted(directory: string, decision: 'approved' | 'rejected', correlationId: string) {
  const graph = buildScriptedApprovalAgent(`${decision}-final`); const paused = await pauseWithScriptedModel(graph); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const durable = await durableAwaiting(directory, paused.approvalKey, correlationId); const task = authoritativeTask(durable.record, { decision });
  await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: graph.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => graph.executions.count, hooks: { checkpoint: async (name) => { if (name === 'after-resume-started-save') throw new Error('stop-at-started'); } } }), /stop-at-started/);
  return { graph, stateStore, receiptStore, store: durable.store, record: await durable.store.load(durable.record.correlationId), task };
}

async function durableCompleted(directory: string, decision: 'approved' | 'rejected', correlationId: string) {
  const graph = buildScriptedApprovalAgent(`${decision}-final`); const paused = await pauseWithScriptedModel(graph); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const durable = await durableAwaiting(directory, paused.approvalKey, correlationId); const task = authoritativeTask(durable.record, { decision });
  const record = await resumeAuthoritativeOaeRun({ agent: graph.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => graph.executions.count });
  return { graph, stateStore, receiptStore, store: durable.store, record, task };
}

test('R2 real ScriptedModel approval restores real RunState and executes protected tool once', async () => {
  const pausedGraph = buildScriptedApprovalAgent('approved-final'); const paused = await pauseWithScriptedModel(pausedGraph);
  assert.equal(pausedGraph.executions.count, 0);
  const serialized = paused.state.toString();
  const resumedGraph = buildScriptedApprovalAgent('approved-final'); const restored = await RunState.fromString(resumedGraph.agent, serialized);
  applyDecision(restored, paused.approvalKey, { decision: 'approved' });
  const result = await run(resumedGraph.agent, restored);
  assert.equal(result.finalOutput, 'approved-final');
  assert.equal(resumedGraph.executions.count, 1);
  resumedGraph.model.assertComplete();
});

test('R2 real ScriptedModel rejected RunState resumes without protected tool execution', async () => {
  const pausedGraph = buildScriptedApprovalAgent('rejected-final'); const paused = await pauseWithScriptedModel(pausedGraph);
  const resumedGraph = buildScriptedApprovalAgent('rejected-final'); const restored = await RunState.fromString(resumedGraph.agent, paused.state.toString());
  applyDecision(restored, paused.approvalKey, { decision: 'rejected' });
  const result = await run(resumedGraph.agent, restored);
  assert.equal(result.finalOutput, 'rejected-final');
  assert.equal(resumedGraph.executions.count, 0);
  resumedGraph.model.assertComplete();
});

test('R2 malformed or wrong OAE decision fails before real SDK approval mutation', async () => {
  const graph = buildScriptedApprovalAgent('never'); const paused = await pauseWithScriptedModel(graph); const before = paused.state.toString();
  assert.throws(() => applyDecision(paused.state, paused.approvalKey, { decision: 'approved', extra: true }), CorrelationSafetyError);
  assert.throws(() => selectApproval(paused.state, 'wrong:identity'), CorrelationSafetyError);
  assert.equal(paused.state.toString(), before);
  assert.equal(graph.executions.count, 0);
});

test('R5e approval identity binds canonical arguments and receipt validation precedes durable final success', async () => {
  const graph = buildScriptedApprovalAgent('final'); const paused = await pauseWithScriptedModel(graph); const item = paused.state.getInterruptions()[0]!; const raw = item.rawItem as { type: string; callId: string; name: string; arguments: string }; const altered = { rawItem: { ...raw, arguments: '{"changed":true}' }, toJSON: () => item.toJSON() } as never; const reorderedLeft = { rawItem: { ...raw, arguments: '{"b":2,"a":1}' }, toJSON: () => item.toJSON() } as never; const reorderedRight = { rawItem: { ...raw, arguments: '{"a":1,"b":2}' }, toJSON: () => item.toJSON() } as never;
  assert.notEqual(approvalIdentity(item), approvalIdentity(altered)); assert.equal(approvalIdentity(reorderedLeft), approvalIdentity(reorderedRight)); const before = paused.state.toString(); assert.throws(() => applyDecision(paused.state, approvalIdentity(altered), { decision: 'approved' }), CorrelationSafetyError); assert.equal(paused.state.toString(), before); assert.equal(graph.executions.count, 0);
  const directory = await mkdtemp(join(tmpdir(), 'r5e-receipt-')); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const durable = await durableAwaiting(directory, paused.approvalKey); const task = authoritativeTask(durable.record); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: graph.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => 0 }), CorrelationSafetyError); await assert.rejects(() => receiptStore.load(), CorrelationSafetyError); assert.equal((await durable.store.load(durable.record.correlationId)).phase, 'resume-started');
});

test('R2 OpenAI adapter accepts only authoritative R1 terminal evidence before SDK mutation', async () => {
  const graph = buildScriptedApprovalAgent('authoritative'); const paused = await pauseWithScriptedModel(graph); const record = oaeRecord(paused.approvalKey); const before = paused.state.toString();
  const valid = authoritativeTask(record); applyAuthoritativeOaeDecision(paused.state, paused.approvalKey, valid, record);
  assert.notEqual(paused.state.toString(), before);

  for (const invalid of [
    { ...valid, id: 'other-task' },
    { ...valid, from: 'attacker@example.test' },
    { ...valid, to: 'attacker@example.test' },
    { ...valid, from: valid.to, to: valid.from, messages: [{ ...valid.messages[0]!, from: valid.to, to: valid.from }, { ...valid.messages[1]!, from: valid.to, to: valid.from }] },
    { ...valid, subject: 'wrong thread', messages: valid.messages.map((message) => ({ ...message, subject: 'wrong thread' })) },
    { ...valid, messages: [{ ...valid.messages[0]!, id: 'root-contradiction', body: 'other root' }, ...valid.messages] },
    { ...valid, messages: [...valid.messages.slice(0, 1), { ...valid.messages[1]!, from: 'attacker@example.test' }] },
    { ...valid, messages: [...valid.messages, { ...valid.messages[1]!, id: 'terminal-2' }] },
    { ...valid, state: 'failed' as const, messages: [...valid.messages.slice(0, 1), { ...valid.messages[1]!, state: 'failed' as const }] },
    { ...valid, messages: [...valid.messages, { ...valid.messages[1]!, id: 'failed-2', state: 'failed' as const }] },
    { ...valid, result: { decision: 'maybe' }, messages: [...valid.messages.slice(0, 1), { ...valid.messages[1]!, result: { decision: 'maybe' } }] },
    { ...valid, result: { decision: 'approved', extra: 'forbidden' } },
  ]) {
    const candidate = buildScriptedApprovalAgent('invalid'); const pausedCandidate = await pauseWithScriptedModel(candidate); const stateBefore = pausedCandidate.state.toString();
    assert.throws(() => applyAuthoritativeOaeDecision(pausedCandidate.state, pausedCandidate.approvalKey, invalid, record), CorrelationSafetyError);
    assert.equal(pausedCandidate.state.toString(), stateBefore); assert.equal(candidate.executions.count, 0);
  }
});

test('R2 RunState owner-only store atomically reloads and rejects unsafe files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-r2-state-')); const store = new RunStateStore(directory); const graph = buildScriptedApprovalAgent('state'); const paused = await pauseWithScriptedModel(graph);
  const serialized = paused.state.toString(); await store.save(serialized); assert.equal(await store.load(), serialized); assert.ok(await restoreRunState(graph.agent, store));
  const path = join(directory, 'run-state.json'); await chmod(path, 0o644); await assert.rejects(() => store.load(), CorrelationSafetyError); await chmod(path, 0o600);
  await writeFile(path, '', { mode: 0o600 }); await assert.rejects(() => store.load(), CorrelationSafetyError);
  await writeFile(path, '{not-sdk-state}', { mode: 0o600 }); await assert.rejects(() => restoreRunState(graph.agent, store), CorrelationSafetyError);
  const linkDirectory = await mkdtemp(join(tmpdir(), 'oae-r2-link-')); await symlink(path, join(linkDirectory, 'run-state.json')); await assert.rejects(() => new RunStateStore(linkDirectory).load(), CorrelationSafetyError);
});

test('R2 RunStateStore confines basename targets and rejects unsafe replacement/race targets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'oae-r2-store-')); const directory = join(parent, 'trusted'); const victim = join(parent, 'victim.json'); await writeFile(victim, 'outside-victim', { mode: 0o600 });
  for (const filename of ['', '.', '..', '../victim.json', '/tmp/victim.json', 'nested/run-state.json', '%2e%2e']) assert.throws(() => new RunStateStore(directory, filename), CorrelationSafetyError);
  const store = new RunStateStore(directory); await store.save('safe-one'); const target = join(directory, 'run-state.json'); await chmod(target, 0o644); await assert.rejects(() => store.save('safe-two'), CorrelationSafetyError); await chmod(target, 0o600);
  await unlink(target); await symlink(victim, target); await assert.rejects(() => store.save('replacement'), CorrelationSafetyError); assert.equal(await readFile(victim, 'utf8'), 'outside-victim'); await unlink(target);
  await mkdir(target); await assert.rejects(() => store.save('directory-target'), CorrelationSafetyError); await rmdir(target);
  const raced = new RunStateStore(directory, 'run-state.json', { beforeRename: async (targetPath) => { await symlink(victim, targetPath); } }); await assert.rejects(() => raced.save('raced'), CorrelationSafetyError); assert.equal(await readFile(victim, 'utf8'), 'outside-victim'); await unlink(target);
  await writeFile(target, 'descriptor-safe', { mode: 0o600 }); const loadRaced = new RunStateStore(directory, 'run-state.json', { beforeLoadFstat: async (targetPath) => { await unlink(targetPath); await symlink(victim, targetPath); } }); assert.equal(await loadRaced.load(), 'descriptor-safe'); assert.equal(await readFile(victim, 'utf8'), 'outside-victim');
});

test('R2 real SDK identity parser coalesces duplicate calls and missing/wrong identities preserve bytes', async () => {
  const graph = buildScriptedApprovalAgent('identity'); const paused = await pauseWithScriptedModel(graph); const restoredGraph = buildScriptedApprovalAgent('identity'); const restored = await RunState.fromString(restoredGraph.agent, paused.state.toString());
  const before = restored.toString(); const item = restored.getInterruptions()[0]!; assert.equal(approvalIdentity(item), paused.approvalKey); assert.equal(approvalIdentity(selectApproval(restored, paused.approvalKey)), approvalIdentity(item));
  for (const wrong of ['approval:missing', paused.approvalKey.replace(/.$/, '0'), 'approval:wrong-tool:wrong-call']) { assert.throws(() => selectApproval(restored, wrong), CorrelationSafetyError); assert.equal(restored.toString(), before); }
  const duplicateModel = new ScriptedModel([[functionCall('protected_action', {}, { callId: 'duplicate-call' }), functionCall('protected_action', {}, { callId: 'duplicate-call' })]]); const duplicateGraph = buildScriptedApprovalAgent('duplicate', { count: 0 }, 'duplicate-call'); duplicateGraph.agent.model = duplicateModel; const duplicated = await run(duplicateGraph.agent, 'go'); const duplicateRestored = await RunState.fromString(duplicateGraph.agent, duplicated.state.toString());
  assert.equal(duplicateRestored.getInterruptions().length, 1); assert.equal(approvalIdentity(duplicateRestored.getInterruptions()[0]!).includes('approval:'), true);
  const collisionJson = JSON.parse(paused.state.toString()) as { currentStep: { data: { interruptions: unknown[] } } }; collisionJson.currentStep.data.interruptions.push(JSON.parse(JSON.stringify(collisionJson.currentStep.data.interruptions[0]))); const collision = await RunState.fromString(restoredGraph.agent, JSON.stringify(collisionJson)); const collisionBefore = collision.toString(); assert.equal(collision.getInterruptions().length, 2); assert.throws(() => selectApproval(collision, paused.approvalKey), CorrelationSafetyError); assert.equal(collision.toString(), collisionBefore); assert.equal(graph.executions.count, 0);
});

test('R2b restored real SDK parser rejects persisted expected identity against wrong tool and call states', async () => {
  const expectedGraph = buildScriptedApprovalAgent('expected'); const expected = await pauseWithScriptedModel(expectedGraph);
  const makeWrong = (name: string, callId: string) => { const executions = { count: 0 }; const guarded = tool({ name, description: name, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute: async () => { executions.count += 1; return name; } }); const model = new ScriptedModel([[functionCall(name, {}, { callId })]]); return { agent: new Agent({ name: `wrong-${name}`, instructions: 'call', tools: [guarded], model }), executions }; };
  for (const [name, callId] of [['wrong_tool', 'approval-call-1'], ['protected_action', 'wrong-call']] as const) { const wrong = makeWrong(name, callId); const paused = await run(wrong.agent, 'go'); const restored = await RunState.fromString(wrong.agent, paused.state.toString()); const before = restored.toString(); assert.throws(() => selectApproval(restored, expected.approvalKey), CorrelationSafetyError); assert.equal(restored.toString(), before); assert.equal(wrong.executions.count, 0); }
});

test('R2 exact identity selection changes only the correlated item among real concurrent SDK interruptions', async () => {
  let correlatedExecutions = 0; let unrelatedExecutions = 0;
  const correlatedTool = tool({ name: 'correlated_action', description: 'correlated', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute: async () => { correlatedExecutions += 1; return 'correlated'; } });
  const unrelatedTool = tool({ name: 'unrelated_action', description: 'unrelated', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute: async () => { unrelatedExecutions += 1; return 'unrelated'; } });
  const pausedModel = new ScriptedModel([[functionCall('correlated_action', {}, { callId: 'correlated-call' }), functionCall('unrelated_action', {}, { callId: 'unrelated-call' })], [assistantMessage('complete')]]);
  const pausedAgent = new Agent({ name: 'two-approvals', instructions: 'use both tools', tools: [correlatedTool, unrelatedTool], model: pausedModel }); const paused = await run(pausedAgent, 'go');
  const keys = paused.state.getInterruptions().map(approvalIdentity); assert.equal(keys.length, 2); const correlatedKey = keys.find((key) => key !== keys[1])!;
  const restoredModel = new ScriptedModel([[functionCall('correlated_action', {}, { callId: 'correlated-call' }), functionCall('unrelated_action', {}, { callId: 'unrelated-call' })], [assistantMessage('complete')]]);
  const restoredAgent = new Agent({ name: 'two-approvals', instructions: 'use both tools', tools: [correlatedTool, unrelatedTool], model: restoredModel }); const restored = await RunState.fromString(restoredAgent, paused.state.toString());
  const before = restored.getInterruptions().map(approvalIdentity); applyDecision(restored, correlatedKey, { decision: 'approved' }); const afterMutation = restored.getInterruptions().map(approvalIdentity); assert.deepEqual(afterMutation, before);
  const again = await run(restoredAgent, restored); assert.deepEqual(again.state.getInterruptions().map(approvalIdentity), [before.find((key) => key !== correlatedKey)!]); assert.equal(correlatedExecutions, 1); assert.equal(unrelatedExecutions, 0);
});

test('R2 reordered real SDK interruptions restore by identity rather than array position', async () => {
  const make = (order: 'forward' | 'reverse') => { const executions = { correlated: 0, unrelated: 0 }; const correlated = tool({ name: 'order_correlated', description: 'correlated', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute: async () => { executions.correlated += 1; return 'c'; } }); const unrelated = tool({ name: 'order_unrelated', description: 'unrelated', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute: async () => { executions.unrelated += 1; return 'u'; } }); const calls = order === 'forward' ? [functionCall('order_correlated', {}, { callId: 'c' }), functionCall('order_unrelated', {}, { callId: 'u' })] : [functionCall('order_unrelated', {}, { callId: 'u' }), functionCall('order_correlated', {}, { callId: 'c' })]; const model = new ScriptedModel([calls, [assistantMessage('done')]]); return { agent: new Agent({ name: `order-${order}`, instructions: 'tools', tools: [correlated, unrelated], model }), executions }; };
  const forward = make('forward'); const first = await run(forward.agent, 'go'); const key = approvalIdentity(first.state.getInterruptions()[0]!); const reversed = make('reverse'); const second = await run(reversed.agent, 'go'); const restored = await RunState.fromString(reversed.agent, second.state.toString()); assert.notEqual(approvalIdentity(restored.getInterruptions()[0]!), key); applyDecision(restored, key, { decision: 'approved' }); const continued = await run(reversed.agent, restored); assert.equal(reversed.executions.correlated, 1); assert.equal(reversed.executions.unrelated, 0); assert.equal(continued.state.getInterruptions().length, 1);
});

test('R2 owner-only state can contain raw workflow input while correlation, receipt and timeline exclude credential canaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-r2-canary-')); const graph = buildScriptedApprovalAgent('canary'); const paused = await pauseWithScriptedModel(graph, 'raw-workflow-canary'); const stateStore = new RunStateStore(directory);
  await stateStore.save(paused.state.toString()); const serialized = await stateStore.load(); assert.ok(serialized.includes('raw-workflow-canary'));
  const record = oaeRecord(paused.approvalKey); const correlationStore = new CorrelationStore(join(directory, 'correlation')); await correlationStore.save(oaeIntent(paused.approvalKey)); await correlationStore.save(transition(oaeIntent(paused.approvalKey), 'create-attempted', { createAttemptedAt: '2026-02-01T00:00:01.000Z' }, '2026-02-01T00:00:01.000Z')); await correlationStore.save(record);
  const correlation = await readFile(join(directory, 'correlation', `${record.correlationId}.json`), 'utf8'); const receipt = JSON.stringify({ evidence: `sdk:${paused.approvalKey}`, executions: 0 });
  const timeline = JSON.stringify(sanitizedTimeline(record, [{ at: '2026-02-01T00:00:00.000Z', phase: 'task-adopted', code: 'resume-failed', authorization: 'Bearer credential-canary', rawBody: 'raw-workflow-canary' } as never]));
  for (const output of [correlation, receipt, timeline]) { assert.ok(!output.includes('credential-canary')); assert.ok(!output.includes('raw-workflow-canary')); }
  for (const input of ['Bearer credential-canary', 'sk-credentialcanary', 'authorization=value', 'token=value', 'safe\r\nunsafe']) { const blocked = buildScriptedApprovalAgent('blocked'); await assert.rejects(() => pauseWithScriptedModel(blocked, input), CorrelationSafetyError); assert.equal(blocked.executions.count, 0); }
});

test('R2 credential canaries are absent from actual pause, decision, final, receipt, correlation and timeline artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-r2-artifact-scan-')); const graph = buildScriptedApprovalAgent('artifact-final'); const paused = await pauseWithScriptedModel(graph, 'raw-noncredential-workflow'); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const pauseArtifact = await stateStore.load(); const durable = await durableAwaiting(directory, paused.approvalKey); const task = authoritativeTask(durable.record); const result = await resumeAuthoritativeOaeRun({ agent: graph.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => graph.executions.count }); const finalArtifact = await stateStore.load(); const receipt = await receiptStore.load(); const correlation = await readFile(join(directory, 'correlation', `${result.correlationId}.json`), 'utf8'); const timeline = JSON.stringify(sanitizedTimeline(result, [{ at: '2026-02-01T00:00:06.000Z', phase: 'resumed', code: 'resume-failed', authorization: 'Bearer credential-canary', rawBody: 'raw-noncredential-workflow' } as never]));
  assert.ok(pauseArtifact.includes('raw-noncredential-workflow')); for (const artifact of [pauseArtifact, finalArtifact, receipt, correlation, timeline]) assert.ok(!artifact.includes('credential-canary'));
});

test('R2c B1 receipt replay matrix isolates every binding field and preserves durable evidence', async () => {
  const mutations: Array<[string, (receipt: Record<string, unknown>) => Record<string, unknown>]> = [
    ['correlationId', (r) => ({ ...r, correlationId: '11111111-1111-4111-8111-111111111111' })], ['taskId', (r) => ({ ...r, taskId: 'other-task' })], ['requestFingerprint', (r) => ({ ...r, requestFingerprint: 'f'.repeat(64) })], ['operationKey', (r) => ({ ...r, operationKey: 'other/op' })], ['approvalItemKey', (r) => ({ ...r, approvalItemKey: 'approval:wrong' })], ['decision', (r) => ({ ...r, decision: 'rejected' })], ['messageId', (r) => ({ ...r, messageId: 'other-message' })], ['evidenceFingerprint', (r) => ({ ...r, evidenceFingerprint: 'e'.repeat(64) })], ['finalStateHash', (r) => ({ ...r, finalStateHash: '0'.repeat(64) })], ['executions', (r) => ({ ...r, executions: 0 })], ['extra', (r) => ({ ...r, extra: true })],
  ];
  const required = ['version', 'correlationId', 'taskId', 'requestFingerprint', 'operationKey', 'approvalItemKey', 'decision', 'messageId', 'evidenceFingerprint', 'finalStateHash', 'executions'];
  for (const field of required) mutations.push([`missing-${field}`, (receipt) => { const copy = { ...receipt }; delete copy[field]; return copy; }]);
  for (const [index, [name, mutate]] of mutations.entries()) {
    const directory = await mkdtemp(join(tmpdir(), `oae-r2c-b1-${name}-`)); const target = await durableCompleted(directory, 'approved', `22222222-2222-4222-8222-2222222222${String(index).padStart(2, '0')}`); const validReceipt = JSON.parse(await target.receiptStore.load()) as Record<string, unknown>; const finalBefore = await target.stateStore.load(); const correlationPath = join(directory, 'correlation', `${target.record.correlationId}.json`); const correlationBefore = await readFile(correlationPath, 'utf8'); await target.receiptStore.save(JSON.stringify(mutate(validReceipt)));
    const restart = buildScriptedApprovalAgent('approved-final'); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: restart.agent, stateStore: target.stateStore, receiptStore: target.receiptStore, correlationStore: target.store, record: target.record, task: target.task, executionCount: () => restart.executions.count }), /resume receipt is missing or contradicts correlation|receipt and final SDK state contradict|resumed correlation receipt evidence contradicts durable record/); assert.equal(await readFile(correlationPath, 'utf8'), correlationBefore, name); assert.equal((await target.store.load(target.record.correlationId)).phase, 'resumed'); assert.equal(await target.stateStore.load(), finalBefore); assert.equal(restart.executions.count, 0);
  }
  for (const [name, record] of [['wrong-resumeEvidence', (r: CorrelationRecord) => ({ ...r, resumeEvidence: 'sdk:wrong' })], ['missing-resumeEvidence', (r: CorrelationRecord) => { const copy = { ...r } as Partial<CorrelationRecord>; delete copy.resumeEvidence; return copy as CorrelationRecord; }]] as const) {
    const directory = await mkdtemp(join(tmpdir(), `oae-r2c-b1-${name}-`)); const target = await durableCompleted(directory, 'approved', name === 'wrong-resumeEvidence' ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444'); const finalBefore = await target.stateStore.load(); const correlationPath = join(directory, 'correlation', `${target.record.correlationId}.json`); const correlationBefore = await readFile(correlationPath, 'utf8'); const restart = buildScriptedApprovalAgent('approved-final'); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: restart.agent, stateStore: target.stateStore, receiptStore: target.receiptStore, correlationStore: target.store, record: record(target.record), task: target.task, executionCount: () => restart.executions.count }), /resumed correlation receipt evidence contradicts durable record/); assert.equal(await readFile(correlationPath, 'utf8'), correlationBefore); assert.equal(await target.stateStore.load(), finalBefore); assert.equal(restart.executions.count, 0);
  }
  const source = await durableCompleted(await mkdtemp(join(tmpdir(), 'oae-r2c-cross-source-')), 'approved', '55555555-5555-4555-8555-555555555555'); const targetDirectory = await mkdtemp(join(tmpdir(), 'oae-r2c-cross-target-')); const target = await durableStarted(targetDirectory, 'rejected', '66666666-6666-4666-8666-666666666666'); const sourceFinal = await source.stateStore.load(); const sourceReceipt = await source.receiptStore.load(); await target.stateStore.save(sourceFinal); await target.receiptStore.save(sourceReceipt); const before = await readFile(join(targetDirectory, 'correlation', `${target.record.correlationId}.json`), 'utf8'); const restart = buildScriptedApprovalAgent('rejected-final'); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: restart.agent, stateStore: target.stateStore, receiptStore: target.receiptStore, correlationStore: target.store, record: target.record, task: target.task, executionCount: () => restart.executions.count }), CorrelationSafetyError); assert.equal(await readFile(join(targetDirectory, 'correlation', `${target.record.correlationId}.json`), 'utf8'), before); assert.equal(restart.executions.count, 0);
});

test('R2c production coordinator fails closed at all real tool crash seams and never uses absent effect evidence', async () => {
  const rows: Array<{ name: 'beforeSideEffect' | 'afterSideEffectBeforeReturn' | 'afterToolReturnInsideSdk'; expectedEffects: number }> = [{ name: 'beforeSideEffect', expectedEffects: 0 }, { name: 'afterSideEffectBeforeReturn', expectedEffects: 1 }, { name: 'afterToolReturnInsideSdk', expectedEffects: 1 }];
  for (const row of rows) {
    const directory = await mkdtemp(join(tmpdir(), `oae-r2c-tool-${row.name}-`)); const observation = join(directory, 'independent-effect-observation'); const executions = { count: 0 }; const hooks = { [row.name]: async () => { if (row.expectedEffects) await writeFile(observation, 'effect-observed', { mode: 0o600 }); throw new Error(`crash-${row.name}`); } };
    const initial = buildScriptedApprovalAgent('tool-crash-final', executions, 'approval-call-1', hooks); const paused = await pauseWithScriptedModel(initial); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const durable = await durableAwaiting(directory, paused.approvalKey); const task = authoritativeTask(durable.record); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: initial.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => executions.count }), new RegExp(`crash-${row.name}`)); const started = await durable.store.load(durable.record.correlationId); assert.equal(started.phase, 'resume-started'); assert.equal(executions.count, row.expectedEffects); if (row.expectedEffects) assert.equal(await readFile(observation, 'utf8'), 'effect-observed');
    const restarted = buildScriptedApprovalAgent('tool-crash-final'); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: restarted.agent, stateStore, receiptStore, correlationStore: durable.store, record: started, task, executionCount: () => restarted.executions.count }), CorrelationSafetyError); assert.equal((await durable.store.load(started.correlationId)).phase, 'resume-started'); assert.equal(restarted.executions.count, 0); assert.equal(executions.count + restarted.executions.count, row.expectedEffects);
  }
});

test('R2c effect without a persisted observation never authorizes a duplicate restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-r2c-effect-without-receipt-')); const executions = { count: 0 }; const initial = buildScriptedApprovalAgent('effect-window-final', executions, 'approval-call-1', { observeEffect: async () => { throw new Error('effect-evidence-persistence-failed'); } }); const paused = await pauseWithScriptedModel(initial); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const durable = await durableAwaiting(directory, paused.approvalKey); const task = authoritativeTask(durable.record);
  await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: initial.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => executions.count }), /effect-evidence-persistence-failed/); const started = await durable.store.load(durable.record.correlationId); assert.equal(started.phase, 'resume-started'); const restarted = buildScriptedApprovalAgent('effect-window-final'); await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: restarted.agent, stateStore, receiptStore, correlationStore: durable.store, record: started, task, executionCount: () => restarted.executions.count }), CorrelationSafetyError); assert.equal((await durable.store.load(started.correlationId)).phase, 'resume-started'); assert.equal(restarted.executions.count, 0); assert.equal(executions.count + restarted.executions.count, 1);
});

test('R2 crash table fails closed after an SDK tool commit with no durable receipt and never re-runs it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-r2-crash-')); const store = new CorrelationStore(directory); const graph = buildScriptedApprovalAgent('crash'); const paused = await pauseWithScriptedModel(graph); const adopted = oaeRecord(paused.approvalKey);
  const inputAttempt = transition(adopted, 'input-request-attempted', { inputEvidence: requestFingerprint({ taskId: 'r2-task-1', body: inputBodyFor(adopted) }) }, '2026-02-01T00:00:03.000Z'); const awaiting = transition(inputAttempt, 'awaiting-input', {}, '2026-02-01T00:00:04.000Z');
  const intent = oaeIntent(paused.approvalKey); const attempted = transition(intent, 'create-attempted', { createAttemptedAt: '2026-02-01T00:00:01.000Z' }, '2026-02-01T00:00:01.000Z'); await store.save(intent); await store.save(attempted); await store.save(adopted); await store.save(inputAttempt); await store.save(awaiting); const task = authoritativeTask(awaiting); let commits = 0;
  await assert.rejects(() => resumeDecision({ save: async (record) => { if (record.phase === 'resumed') throw new Error('crash after SDK run before final evidence'); await store.save(record); } }, awaiting, task, { commit: async () => { commits += 1; applyAuthoritativeOaeDecision(paused.state, paused.approvalKey, task, awaiting); await run(graph.agent, paused.state); return `sdk:${paused.approvalKey}`; }, committedEvidence: async () => null }), /crash after SDK run/);
  const restarted = await store.load(awaiting.correlationId); assert.equal(restarted.phase, 'resume-started'); assert.equal(graph.executions.count, 1);
  await assert.rejects(() => resumeDecision(store, restarted, task, { commit: async () => { commits += 1; return 'must-not-run'; }, committedEvidence: async () => null }), /refusing blind second resume/);
  assert.equal(commits, 1); assert.equal(graph.executions.count, 1);
});

test('R2 durable coordinator G5 checkpoints recover exactly or fail closed without a second SDK run', async () => {
  const rows = ['before-sdk-decision-mutation', 'after-sdk-decision-mutation', 'before-decision-applied-state-save', 'after-decision-applied-state-save', 'before-resume-started-save', 'after-resume-started-save', 'before-sdk-run', 'after-sdk-run', 'before-final-state-save', 'after-final-state-save', 'before-receipt-save', 'after-receipt-save', 'before-resumed-save', 'after-resumed-save'];
  for (const row of rows) {
    const directory = await mkdtemp(join(tmpdir(), `oae-r2-g5-${row}-`)); const initial = buildScriptedApprovalAgent('g5-final'); const paused = await pauseWithScriptedModel(initial); const stateStore = new RunStateStore(directory); const receiptStore = new RunStateStore(directory, 'tool-receipt.json'); await stateStore.save(paused.state.toString()); const durable = await durableAwaiting(directory, paused.approvalKey); const task = authoritativeTask(durable.record);
    await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: initial.agent, stateStore, receiptStore, correlationStore: durable.store, record: durable.record, task, executionCount: () => initial.executions.count, hooks: { checkpoint: async (name) => { if (name === row) throw new Error(`injected-${row}`); } } }), new RegExp(`injected-${row}`));
    const afterCrash = await durable.store.load(durable.record.correlationId); const restarted = buildScriptedApprovalAgent('g5-final'); const mustFailClosed = afterCrash.phase === 'resume-started' && row !== 'after-receipt-save' && row !== 'before-resumed-save' && row !== 'after-resumed-save';
    if (mustFailClosed) { await assert.rejects(() => resumeAuthoritativeOaeRun({ agent: restarted.agent, stateStore, receiptStore, correlationStore: durable.store, record: afterCrash, task, executionCount: () => restarted.executions.count }), CorrelationSafetyError); assert.equal(restarted.executions.count, 0); continue; }
    const recovered = await resumeAuthoritativeOaeRun({ agent: restarted.agent, stateStore, receiptStore, correlationStore: durable.store, record: afterCrash, task, executionCount: () => restarted.executions.count }); assert.equal(recovered.phase, 'resumed'); const final = await restoreRunState(restarted.agent, stateStore); assert.equal(final.getInterruptions().length, 0); assert.equal(initial.executions.count + restarted.executions.count, 1);
  }
});

test('R2 two fresh child processes restore approved and rejected ScriptedModel RunStates without a key', async () => {
  const runner = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'); const fixture = join(process.cwd(), 'test/fixtures/openai-r2-child.ts');
  for (const decision of ['approved', 'rejected'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `oae-r2-child-${decision}-`));
    for (const mode of ['pause', 'decide', 'resume', 'resume']) { const child = spawnSync(process.execPath, [runner, fixture, mode, directory, decision], { encoding: 'utf8', env: {} }); assert.equal(child.status, 0, `${mode}: ${child.stderr}`); }
    const paused = JSON.parse(await readFile(join(directory, 'pause-result.json'), 'utf8')) as { taskId: string; phase: string; approvals: number; executions: number };
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as { decision: string; phase: string; taskId: string; executions: number; final: string; pendingInterruptions: number; receipt: number };
    assert.deepEqual(paused, { taskId: 'r2-task-1', phase: 'awaiting-input', approvals: 1, executions: 0 });
    assert.equal(result.decision, decision); assert.equal(result.phase, 'resumed'); assert.equal(result.taskId, 'r2-task-1'); assert.equal(result.executions, decision === 'approved' ? 1 : 0); assert.equal(result.final, `${decision}-final`); assert.equal(result.pendingInterruptions, 0); assert.equal(result.receipt, 64);
  }
});

test('R2 live entrypoint explicitly skips without an API key or network client', () => {
  const runner = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'); const fixture = join(process.cwd(), 'test/fixtures/live-no-key-child.ts');
  const child = spawnSync(process.execPath, [runner, fixture], { encoding: 'utf8', env: {} });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'skipped-no-key');
});
