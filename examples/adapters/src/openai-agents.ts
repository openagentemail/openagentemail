import { constants, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { Agent, RunState, run, tool, type RunToolApprovalItem } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall, modelResponder } from '@openai/agents/testing';
import { CorrelationSafetyError, canonicalJson, isCredentialShaped, transition, type CorrelationRecord } from './correlation-store.js';
import type { OaeTask } from './openagentemail.js';
import { receiveDecision, validateDecision } from './retry.js';

export type OaeDecision = { decision: 'approved' | 'rejected' };
/** Test seams exercise real SDK continuation boundaries; observeEffect is never a recovery signal. */
export interface ToolCrashHooks { beforeSideEffect?: () => Promise<void>; observeEffect?: () => Promise<void>; afterSideEffectBeforeReturn?: () => Promise<void>; afterToolReturnInsideSdk?: () => Promise<void>; }
export type DeterministicAgent = { agent: Agent; model: ScriptedModel; executions: { count: number } };
type CorrelationWriter = { save(record: CorrelationRecord): Promise<void> };
const SAFE_FILENAMES = new Set(['run-state.json', 'tool-receipt.json']);

/** SDK identity includes canonical invocation arguments, not merely a transport call ID. */
export function approvalIdentity(item: RunToolApprovalItem): string {
  const raw = item.rawItem;
  if (raw.type !== 'function_call' || !raw.callId || !raw.name) throw new CorrelationSafetyError('approval interruption lacks a stable SDK function identity');
  const sdkToolKey = item.toJSON().functionToolStateKey;
  if (!sdkToolKey) throw new CorrelationSafetyError('approval interruption lacks an SDK tool state key');
  const argumentsText = (raw as { arguments?: unknown }).arguments; if (typeof argumentsText !== 'string') throw new CorrelationSafetyError('approval interruption lacks canonical tool arguments'); let argumentsValue: unknown; try { argumentsValue = JSON.parse(argumentsText); } catch { throw new CorrelationSafetyError('approval interruption has invalid tool arguments'); }
  return `approval:${createHash('sha256').update(canonicalJson({ sdkToolKey, name: raw.name, callId: raw.callId, arguments: argumentsValue })).digest('hex')}`;
}

export function selectApproval(state: RunState<any, Agent>, expected: string): RunToolApprovalItem {
  const matches = state.getInterruptions().filter((item) => approvalIdentity(item) === expected);
  if (matches.length !== 1) throw new CorrelationSafetyError(`expected exactly one correlated SDK interruption, got ${matches.length}`);
  return matches[0]!;
}

export function applyDecision(state: RunState<any, Agent>, expected: string, result: unknown): void {
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || !('decision' in result) || ((result as OaeDecision).decision !== 'approved' && (result as OaeDecision).decision !== 'rejected')) throw new CorrelationSafetyError('OAE decision must be exactly approved or rejected before SDK mutation');
  const item = selectApproval(state, expected);
  if ((result as OaeDecision).decision === 'approved') state.approve(item); else state.reject(item);
}

/** The OpenAI boundary accepts only R1's full-history, authoritative terminal evidence. */
export function applyAuthoritativeOaeDecision(state: RunState<any, Agent>, expected: string, task: OaeTask, record: CorrelationRecord): void {
  const { value } = validateDecision(task, record); applyDecision(state, expected, value);
}

/** Reject credentials and header/error-shaped content before it can reach SDK state. */
export function safeWorkflowInput(input: string): string {
  if (!input || isCredentialShaped(input)) throw new CorrelationSafetyError('workflow input is empty or credential-shaped');
  return input;
}

export function buildScriptedApprovalAgent(finalText: string, executions = { count: 0 }, callId = 'approval-call-1', crashHooks: ToolCrashHooks = {}): DeterministicAgent {
  let deferredToolCrash: unknown;
  const protectedTool = tool({ name: 'protected_action', description: 'A protected deterministic action', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute: async () => { try { await crashHooks.beforeSideEffect?.(); executions.count += 1; await crashHooks.observeEffect?.(); await crashHooks.afterSideEffectBeforeReturn?.(); return 'protected-action-completed'; } catch (error) { deferredToolCrash = error; return 'interrupted-before-model-continuation'; } } });
  const model = new ScriptedModel([[functionCall('protected_action', {}, { callId })], modelResponder(async () => { if (deferredToolCrash) throw deferredToolCrash; await crashHooks.afterToolReturnInsideSdk?.(); return [assistantMessage(finalText)]; })]);
  return { agent: new Agent({ name: 'oae-approval-root', instructions: 'Use the protected action once.', tools: [protectedTool], model }), model, executions };
}

export async function pauseWithScriptedModel(graph: DeterministicAgent, input = 'perform protected action'): Promise<{ state: RunState<any, Agent>; approvalKey: string }> {
  const result = await run(graph.agent, safeWorkflowInput(input)); const interruptions = result.state.getInterruptions();
  if (interruptions.length !== 1 || graph.executions.count !== 0) throw new CorrelationSafetyError('SDK run did not pause on exactly one unexecuted approval');
  return { state: result.state, approvalKey: approvalIdentity(interruptions[0]!) };
}

export interface RunStateStoreHooks { beforeRename?: (target: string) => Promise<void>; beforeLoadFstat?: (target: string) => Promise<void>; }
/** Owner-only sensitive state with a fixed filename allowlist and descriptor-based loads. */
export class RunStateStore {
  readonly filename: string;
  constructor(readonly directory: string, filename = 'run-state.json', private readonly hooks: RunStateStoreHooks = {}) { this.filename = safeFilename(filename); }
  async save(serialized: string): Promise<void> {
    if (!serialized) throw new CorrelationSafetyError('serialized RunState is empty');
    const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename); const before = await fileIdentity(target);
    const temporary = contained(directory, `.${this.filename}.${randomUUID()}.tmp`); let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await safeFileAtPath(temporary); await this.hooks.beforeRename?.(target); if (!sameIdentity(before, await fileIdentity(target))) throw new CorrelationSafetyError('RunState target changed during atomic replacement'); await rename(temporary, target); created = false; await safeFileAtPath(target); await fsyncDirectory(directory);
    } catch (error) { if (created) await safeRemove(temporary); throw error; }
  }
  async load(): Promise<string> {
    const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename);
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new CorrelationSafetyError('RunState file cannot be safely loaded'); }
    try { await this.hooks.beforeLoadFstat?.(target); await safeFileHandle(handle); const text = await handle.readFile({ encoding: 'utf8' }); if (!text) throw new CorrelationSafetyError('serialized RunState is corrupt or truncated'); return text; }
    catch (error) { if (error instanceof CorrelationSafetyError) throw error; throw new CorrelationSafetyError('RunState file cannot be safely loaded'); }
    finally { await handle.close(); }
  }
}

export async function restoreRunState(agent: Agent, store: RunStateStore): Promise<RunState<any, Agent>> {
  try { return await RunState.fromString(agent, await store.load()); }
  catch (error) { if (error instanceof CorrelationSafetyError) throw error; throw new CorrelationSafetyError('serialized RunState is corrupt or not restorable by this SDK graph'); }
}

type ResumeReceipt = { version: 2; correlationId: string; taskId: string; requestFingerprint: string; operationKey: string; approvalItemKey: string; decision: OaeDecision['decision']; messageId: string; evidenceFingerprint: string; finalStateHash: string; executions: number };
export interface DurableResumeHooks { checkpoint?: (name: string) => Promise<void>; }
export interface DurableResumeInput { agent: Agent; stateStore: RunStateStore; receiptStore: RunStateStore; correlationStore: CorrelationWriter; record: CorrelationRecord; task: OaeTask; executionCount: () => number; hooks?: DurableResumeHooks; }

/** Coordinates correlation, SDK state and receipt so restart never blindly re-runs a tool. */
export async function resumeAuthoritativeOaeRun(input: DurableResumeInput): Promise<CorrelationRecord> {
  const { agent, stateStore, receiptStore, correlationStore, task, hooks } = input; let record = await receiveDecision(correlationStore, input.record, task);
  const checkpoint = async (name: string) => hooks?.checkpoint?.(name);
  if (!record.approvalItemKey) throw new CorrelationSafetyError('authoritative OAE resume lacks approval identity'); const approvalItemKey = record.approvalItemKey;
  if (record.phase === 'resumed') { await verifyFinalEvidence(agent, stateStore, receiptStore, record); return record; }
  if (record.phase === 'resume-started') {
    await checkpoint('before-restart-reconcile');
    const receipt = await verifyFinalEvidence(agent, stateStore, receiptStore, record); const resumed = transition(record, 'resumed', { resumeEvidence: receiptEvidence(receipt) }); await correlationStore.save(resumed); return resumed;
  }
  if (record.phase !== 'decision-received') throw new CorrelationSafetyError(`cannot resume SDK from correlation phase ${record.phase}`);
  const state = await restoreRunState(agent, stateStore); await checkpoint('before-sdk-decision-mutation'); applyAuthoritativeOaeDecision(state, approvalItemKey, task, record); await checkpoint('after-sdk-decision-mutation');
  await checkpoint('before-decision-applied-state-save'); await stateStore.save(state.toString()); await checkpoint('after-decision-applied-state-save');
  const started = transition(record, 'resume-started'); await checkpoint('before-resume-started-save'); await correlationStore.save(started); await checkpoint('after-resume-started-save'); record = started;
  return finishStartedRun(input, record, state, checkpoint, approvalItemKey);
}

async function finishStartedRun(input: DurableResumeInput, record: CorrelationRecord, state: RunState<any, Agent>, checkpoint: (name: string) => Promise<void>, approvalItemKey: string): Promise<CorrelationRecord> {
  const { agent, stateStore, receiptStore, correlationStore, task } = input;
  await checkpoint('before-sdk-run'); const completed = await run(agent, state); void completed; await checkpoint('after-sdk-run');
  if (state.getInterruptions().length !== 0) throw new CorrelationSafetyError('SDK completed with a pending interruption');
  const finalState = state.toString(); const { value, evidence } = validateDecision(task, record); if (!record.taskId) throw new CorrelationSafetyError('final receipt lacks adopted task ID'); const receipt: ResumeReceipt = { version: 2, correlationId: record.correlationId, taskId: record.taskId, requestFingerprint: record.requestFingerprint, operationKey: record.operationKey, approvalItemKey, decision: value.decision, messageId: evidence.messageId, evidenceFingerprint: evidence.evidenceFingerprint, finalStateHash: sha(finalState), executions: input.executionCount() }; validateReceipt(receipt, record);
  await checkpoint('before-final-state-save'); await stateStore.save(finalState); await checkpoint('after-final-state-save'); await checkpoint('before-receipt-save'); await receiptStore.save(JSON.stringify(receipt)); await checkpoint('after-receipt-save');
  const resumed = transition(record, 'resumed', { resumeEvidence: receiptEvidence(receipt) }); await checkpoint('before-resumed-save'); await correlationStore.save(resumed); await checkpoint('after-resumed-save'); return resumed;
}

async function verifyFinalEvidence(agent: Agent, stateStore: RunStateStore, receiptStore: RunStateStore, record: CorrelationRecord): Promise<ResumeReceipt> {
  let receipt: unknown; try { receipt = JSON.parse(await receiptStore.load()); } catch { throw new CorrelationSafetyError('resume has no durable receipt; refusing blind SDK rerun'); }
  const checked = validateReceipt(receipt, record); if (record.phase === 'resumed' && record.resumeEvidence !== receiptEvidence(checked)) throw new CorrelationSafetyError('resumed correlation receipt evidence contradicts durable record'); const finalText = await stateStore.load(); if (sha(finalText) !== checked.finalStateHash) throw new CorrelationSafetyError('receipt and final SDK state contradict');
  const state = await restoreRunState(agent, stateStore); if (state.getInterruptions().length !== 0) throw new CorrelationSafetyError('final SDK state still has pending interruptions'); return checked;
}
function validateReceipt(value: unknown, record: CorrelationRecord): ResumeReceipt {
  const row = value as Partial<ResumeReceipt>; const evidence = record.decisionEvidence; if (!row || typeof row !== 'object' || Object.keys(row).length !== 11 || row.version !== 2 || !record.taskId || !evidence || row.correlationId !== record.correlationId || row.taskId !== record.taskId || row.requestFingerprint !== record.requestFingerprint || row.operationKey !== record.operationKey || row.approvalItemKey !== record.approvalItemKey || row.decision !== evidence.decision || row.messageId !== evidence.messageId || row.evidenceFingerprint !== evidence.evidenceFingerprint || typeof row.finalStateHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.finalStateHash) || typeof row.executions !== 'number' || !Number.isInteger(row.executions) || row.executions !== (row.decision === 'approved' ? 1 : 0)) throw new CorrelationSafetyError('resume receipt is missing or contradicts correlation'); return row as ResumeReceipt;
}
function receiptEvidence(receipt: ResumeReceipt): string { return `sdk:${sha(canonicalJson(receipt))}`; }
function sha(text: string): string { return createHash('sha256').update(text).digest('hex'); }

function safeFilename(filename: string): string { if (!SAFE_FILENAMES.has(filename) || !filename || filename === '.' || filename === '..' || basename(filename) !== filename || isAbsolute(filename) || /[\\/]|%2e|%2f/i.test(filename)) throw new CorrelationSafetyError('RunState filename is not an allowed single basename'); return filename; }
function contained(directory: string, filename: string): string { const target = resolve(directory, filename); if (target === directory || !target.startsWith(`${directory}/`)) throw new CorrelationSafetyError('RunState target escapes trusted directory'); return target; }
async function trustedDirectory(path: string): Promise<string> { await mkdir(path, { recursive: true, mode: 0o700 }); const entry = await lstat(path); if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid() || (entry.mode & 0o777) !== 0o700) throw new CorrelationSafetyError('RunState directory must be owner-owned mode 0700'); return realpath(path); }
async function safeExistingTarget(path: string): Promise<void> { try { await safeFileAtPath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } }
async function safeFileAtPath(path: string): Promise<void> { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid() || (entry.mode & 0o777) !== 0o600 || !(await stat(path)).isFile()) throw new CorrelationSafetyError('RunState file must be owner-owned regular mode 0600'); }
async function fileIdentity(path: string): Promise<{ dev: number; ino: number } | null> { try { await safeFileAtPath(path); const entry = await lstat(path); return { dev: entry.dev, ino: entry.ino }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
function sameIdentity(first: { dev: number; ino: number } | null, second: { dev: number; ino: number } | null): boolean { return first === null ? second === null : second !== null && first.dev === second.dev && first.ino === second.ino; }
async function safeFileHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> { const entry = await handle.stat(); if (!entry.isFile() || entry.uid !== uid() || (entry.mode & 0o777) !== 0o600) throw new CorrelationSafetyError('RunState descriptor must be owner-owned regular mode 0600'); }
async function fsyncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
async function safeRemove(path: string): Promise<void> { try { const entry = await lstat(path); if (entry.isFile() && !entry.isSymbolicLink()) await unlink(path); } catch { /* owned temporary only */ } }
function uid(): number { const value = process.getuid?.(); if (value === undefined) throw new CorrelationSafetyError('owner validation unavailable'); return value; }

export interface ExplicitLiveDependencies {
  /** Local tests may model authorization without providing an API key or a network client. */
  authorized?: boolean;
  run?: (input: string) => Promise<unknown>;
}

/** Explicit live-only path. Its no-key branch returns before agent construction, client creation, or network activity. */
export async function runExplicitLiveExample(input: string, dependencies: ExplicitLiveDependencies = {}): Promise<{ status: 'skipped-no-key' | 'completed'; output?: string }> {
  const authorized = dependencies.authorized ?? Boolean(process.env.OPENAI_API_KEY); if (!authorized) return { status: 'skipped-no-key' };
  const workflow = safeWorkflowInput(input);
  const output = dependencies.run ? await dependencies.run(workflow) : (await run(new Agent({ name: 'explicit-user-live-example', instructions: 'Reply concisely.' }), workflow)).finalOutput;
  return { status: 'completed', output: safeLiveOutput(output) };
}

/** CLI output is deliberately status-first and bounded to the already-sanitized returned model text. */
export function formatExplicitLiveResult(result: { status: 'skipped-no-key' | 'completed'; output?: string }): string {
  return result.status === 'skipped-no-key' ? 'skipped-no-key\n' : `completed\n${result.output ?? '[missing model output]'}\n`;
}

function safeLiveOutput(value: unknown): string {
  let text: string; try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = '[unserializable model output]'; }
  text = neutralizeTerminalControls(text);
  if (!text || isCredentialShaped(text.replace(/\n/g, ' '))) return '[redacted model output]';
  return text.slice(0, 4096);
}

/** Preserve printable text/tabs/newlines while removing terminal control execution and normalizing CRLF. */
function neutralizeTerminalControls(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x9d[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
