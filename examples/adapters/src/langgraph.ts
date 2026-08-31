import { createHash, randomUUID } from 'node:crypto';
import { constants, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { CorrelationSafetyError, canonicalJson, isCredentialShaped, requestFingerprint, transition, type CorrelationRecord } from './correlation-store.js';
import type { OaeTask } from './openagentemail.js';
import { createOrAdopt, receiveDecision, requestInputOrReconcile, validateDecision, withMarker } from './retry.js';

const DB_FILENAME = 'langgraph-checkpoints.sqlite';
const GRAPH_NAME = 'oae-approval-graph';
const NODE_NAME = 'await_authoritative_decision';

const LangState = Annotation.Root({ workflow: Annotation<string>, threadId: Annotation<string>, operationKey: Annotation<string>, decision: Annotation<'approved' | 'rejected'>(), effect: Annotation<number>() });
type GraphConfig = { configurable: { thread_id: string } };
type EffectBinding = { correlationId: string; taskId: string; requestFingerprint: string; operationKey: string; threadId: string; decision: 'approved' | 'rejected'; messageId: string; evidenceFingerprint: string };
type EffectLedger = EffectBinding & { version: 1; effectId: string };
type EffectObservation = EffectBinding & { version: 1; effectLedgerFingerprint: string; effects: 1 };
type Receipt = EffectBinding & { version: 2; finalCheckpointId: string; finalStateFingerprint: string; effectObservationFingerprint: string; effects: 1 };

export interface LangGraphPauseInput { directory: string; threadId: string; workflow: string; record: CorrelationRecord; correlationStore: { save(record: CorrelationRecord): Promise<void> }; oae: Parameters<typeof createOrAdopt>[1] & Parameters<typeof requestInputOrReconcile>[1]; checkpoints?: (name: string) => Promise<void>; }
export interface LangGraphResumeInput { directory: string; threadId: string; record: CorrelationRecord; correlationStore: { save(record: CorrelationRecord): Promise<void> }; task: OaeTask; onEffect?: () => void; checkpoints?: (name: string) => Promise<void>; }

export function langGraphOperationKey(threadId: string): string { return `langgraph/${GRAPH_NAME}/${NODE_NAME}/${safeThreadId(threadId)}`; }
export function langGraphApprovalKey(threadId: string): string { return `langgraph-thread:${safeThreadId(threadId)}`; }
export function safeLangGraphWorkflow(value: string): string { if (!value || isCredentialShaped(value)) throw new CorrelationSafetyError('LangGraph workflow input is empty or credential-shaped'); return value; }

/** Opens the real SQLite saver only after exact owner-only directory/file validation. */
export async function openLangGraphSqlite(directory: string): Promise<{ saver: SqliteSaver; databasePath: string; close(): Promise<void> }> {
  const trusted = await trustedDirectory(directory); const databasePath = contained(trusted, DB_FILENAME); await ensureDatabaseFile(databasePath); await validateSqliteArtifacts(trusted);
  const saver = SqliteSaver.fromConnString(databasePath);
  try { saver.db.pragma('journal_mode = WAL'); await saver.getTuple({ configurable: { thread_id: '__langgraph_safety_probe__' } }); await validateSqliteArtifacts(trusted); }
  catch (error) { try { saver.db.close(); } catch { /* best effort after failed open */ } throw error; }
  return { saver, databasePath, async close() { try { saver.db.pragma('wal_checkpoint(TRUNCATE)'); } finally { saver.db.close(); } await validateSqliteArtifacts(trusted); } };
}

export async function validateLangGraphSqlite(directory: string): Promise<void> { await validateSqliteArtifacts(await trustedDirectory(directory)); }

export function buildLangGraph(saver: SqliteSaver, effectSink?: EffectSink, onEffect?: () => void) {
  return new StateGraph(LangState)
    .addNode(NODE_NAME, async (state) => {
      const resumed = interrupt({ kind: 'oae-authoritative-decision', threadId: state.threadId, operationKey: state.operationKey });
      const decision = exactDecision(resumed); if (!effectSink) throw new CorrelationSafetyError('LangGraph resumed node lacks its protected effect sink'); const observation = await effectSink.execute(decision); onEffect?.(); return { decision: decision.decision, effect: observation.effects };
    })
    .addEdge(START, NODE_NAME).addEdge(NODE_NAME, END).compile({ checkpointer: saver });
}
type CompiledGraph = ReturnType<typeof buildLangGraph>;

/** Real initial invoke: the node reaches interrupt() before any effect or OAE external action. */
export async function pauseLangGraph(input: LangGraphPauseInput): Promise<CorrelationRecord> {
  safeLangGraphWorkflow(input.workflow); assertBinding(input.record, input.threadId);
  const checkpoint = await openLangGraphSqlite(input.directory);
  try {
    const graph = buildLangGraph(checkpoint.saver); const config = graphConfig(input.threadId); const mark = async (name: string) => input.checkpoints?.(name); let record = input.record;
    if (record.phase === 'intent-created') { await mark('before-initial-invoke'); const paused = await graph.invoke({ workflow: input.workflow, threadId: input.threadId, operationKey: input.record.operationKey }, config); const interrupted = paused as unknown as { __interrupt__?: unknown[] }; if (!Array.isArray(interrupted.__interrupt__) || interrupted.__interrupt__.length !== 1) throw new CorrelationSafetyError('real LangGraph invoke did not persist exactly one interrupt'); await mark('after-initial-invoke'); await mark('before-checkpoint-visible'); const state = await graph.getState(config); if (state.next.length !== 1 || state.next[0] !== NODE_NAME) throw new CorrelationSafetyError('LangGraph interrupt is not durably visible'); await mark('after-checkpoint-visible'); }
    else { const state = await graph.getState(config); if (state.next.length !== 1 || state.next[0] !== NODE_NAME) throw new CorrelationSafetyError('LangGraph re-entry lacks the original durable interrupt'); }
    if (record.phase === 'intent-created' || record.phase === 'create-attempted') { await mark('before-task-adopt'); record = await createOrAdopt(input.correlationStore, input.oae, record, { to: record.expectedParticipants.responder, subject: awaitSubject(record), body: input.workflow }); await mark('after-task-adopt'); }
    if (record.phase === 'task-adopted' || record.phase === 'input-request-attempted') { await mark('before-input-accept'); record = await requestInputOrReconcile(input.correlationStore, input.oae, record); await mark('after-input-accept'); }
    if (record.phase !== 'awaiting-input') throw new CorrelationSafetyError(`LangGraph pause cannot finish in ${record.phase}`); return record;
  } finally { await checkpoint.close(); }
}

/** Resume is fail-closed: a durable resume-started record never invokes Command again without a bound receipt. */
export async function resumeLangGraph(input: LangGraphResumeInput): Promise<CorrelationRecord> {
  assertBinding(input.record, input.threadId); const checkpoint = await openLangGraphSqlite(input.directory);
  const mark = async (name: string) => input.checkpoints?.(name);
  try {
    await mark('before-decision-evidence'); let record = await receiveDecision(input.correlationStore, input.record, input.task); await mark('after-decision-evidence'); const receiptStore = new ReceiptStore(input.directory, receiptFilename(record)); const effectSink = new EffectSink(input.directory, bindingFrom(record, input.threadId), mark);
    const graph = buildLangGraph(checkpoint.saver, effectSink, input.onEffect); const config = graphConfig(input.threadId);
    if (record.phase === 'resumed') { await verifyReceipt(receiptStore, effectSink, graph, config, record, input.threadId); return record; }
    if (record.phase === 'resume-started') { const receipt = await verifyReceipt(receiptStore, effectSink, graph, config, record, input.threadId); const resumed = transition(record, 'resumed', { resumeEvidence: receiptEvidence(receipt) }); await input.correlationStore.save(resumed); return resumed; }
    if (record.phase !== 'decision-received') throw new CorrelationSafetyError(`LangGraph cannot resume from ${record.phase}`);
    const before = await graph.getState(config); if (!Array.isArray(before.next) || before.next.length !== 1 || before.next[0] !== NODE_NAME) throw new CorrelationSafetyError('LangGraph checkpoint is absent, foreign, corrupt, or not interrupted');
    await mark('before-resume-started'); const started = transition(record, 'resume-started'); await input.correlationStore.save(started); await mark('after-resume-started'); record = started;
    await mark('before-command-resume'); const { value, evidence } = validateDecision(input.task, record); await mark('before-graph-completion'); await graph.invoke(new Command({ resume: value }), config); await mark('after-command-resume'); await mark('after-graph-completion');
    const final = await graph.getState(config); const finalCheckpointId = checkpointId(final); const values = final.values as Record<string, unknown>; const observation = await effectSink.inspect();
    if (final.next.length !== 0 || values.decision !== value.decision || values.effect !== observation.effects) throw new CorrelationSafetyError('LangGraph resumed checkpoint lacks its exact final decision/effect state');
    const receipt: Receipt = { version: 2, ...bindingFrom(record, input.threadId), finalCheckpointId, finalStateFingerprint: sha(canonicalJson(values)), effectObservationFingerprint: sha(canonicalJson(observation)), effects: observation.effects };
    await mark('before-receipt-save'); await receiptStore.save(receipt); await mark('after-receipt-save'); const resumed = transition(record, 'resumed', { resumeEvidence: receiptEvidence(receipt) }); await mark('before-resumed-save'); await input.correlationStore.save(resumed); await mark('after-resumed-save'); return resumed;
  } finally { await checkpoint.close(); }
}

/** Opens a fresh real SQLite connection and derives final decision/effect evidence from the checkpoint itself. */
export async function inspectLangGraphFinal(directory: string, threadId: string, record: CorrelationRecord): Promise<{ decision: 'approved' | 'rejected'; effects: 1; checkpointId: string; finalStateFingerprint: string; effectObservationFingerprint: string }> {
  const checkpoint = await openLangGraphSqlite(directory); try { const final = await buildLangGraph(checkpoint.saver).getState(graphConfig(threadId)); const values = final.values as Record<string, unknown>; const decision = values.decision; const observation = await new EffectSink(directory, bindingFrom(record, threadId)).inspect(); if (final.next.length !== 0 || decision !== observation.decision || values.effect !== observation.effects) throw new CorrelationSafetyError('LangGraph SQLite checkpoint is not a completed durable-effect final state'); return { decision: observation.decision, effects: observation.effects, checkpointId: checkpointId(final), finalStateFingerprint: sha(canonicalJson(values)), effectObservationFingerprint: sha(canonicalJson(observation)) }; } finally { await checkpoint.close(); }
}

function awaitSubject(record: CorrelationRecord): string { return withMarker(record, 'R3 LangGraph approval'); }
function graphConfig(threadId: string): GraphConfig { return { configurable: { thread_id: safeThreadId(threadId) } }; }
function safeThreadId(value: string): string { if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value) || isCredentialShaped(value)) throw new CorrelationSafetyError('LangGraph thread_id is unsafe'); return value; }
function assertBinding(record: CorrelationRecord, threadId: string): void { if (record.framework !== 'langgraph' || record.operationKey !== langGraphOperationKey(threadId) || record.approvalItemKey !== langGraphApprovalKey(threadId) || record.frameworkStateRef !== DB_FILENAME) throw new CorrelationSafetyError('LangGraph correlation does not bind this thread/checkpoint identity'); }
function exactDecision(value: unknown): { decision: 'approved' | 'rejected' } { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || Object.keys(value)[0] !== 'decision' || ((value as { decision?: unknown }).decision !== 'approved' && (value as { decision?: unknown }).decision !== 'rejected')) throw new CorrelationSafetyError('LangGraph Command resume must be exactly an authoritative decision'); return value as { decision: 'approved' | 'rejected' }; }
function bindingFrom(record: CorrelationRecord, threadId: string): EffectBinding { if (!record.taskId || !record.decisionEvidence) throw new CorrelationSafetyError('LangGraph effect lacks authoritative OAE evidence'); return { correlationId: record.correlationId, taskId: record.taskId, requestFingerprint: record.requestFingerprint, operationKey: record.operationKey, threadId, decision: record.decisionEvidence.decision, messageId: record.decisionEvidence.messageId, evidenceFingerprint: record.decisionEvidence.evidenceFingerprint }; }
function checkpointId(state: unknown): string { const row = state as { config?: { configurable?: { checkpoint_id?: unknown } } }; const id = row.config?.configurable?.checkpoint_id; if (typeof id !== 'string' || !/^[A-Za-z0-9-]{16,120}$/.test(id)) throw new CorrelationSafetyError('LangGraph final checkpoint identity is unsafe'); return id; }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function receiptEvidence(receipt: Receipt): string { return `langgraph:${sha(canonicalJson(receipt))}`; }

async function verifyReceipt(store: ReceiptStore, effectSink: EffectSink, graph: CompiledGraph, config: GraphConfig, record: CorrelationRecord, threadId: string): Promise<Receipt> {
  const receipt = validateReceipt(await store.load(), record, threadId); const observation = await effectSink.inspect(); if (receipt.effectObservationFingerprint !== sha(canonicalJson(observation)) || receipt.effects !== observation.effects) throw new CorrelationSafetyError('LangGraph receipt and durable effect observation contradict'); if (record.phase === 'resumed' && record.resumeEvidence !== receiptEvidence(receipt)) throw new CorrelationSafetyError('LangGraph resumed receipt contradicts durable correlation'); const final = await graph.getState(config); const values = final.values as Record<string, unknown>; if (final.next.length !== 0 || checkpointId(final) !== receipt.finalCheckpointId || sha(canonicalJson(values)) !== receipt.finalStateFingerprint || values.decision !== receipt.decision || values.effect !== observation.effects) throw new CorrelationSafetyError('LangGraph receipt and final SQLite checkpoint contradict'); return receipt;
}
function validateReceipt(value: unknown, record: CorrelationRecord, threadId: string): Receipt {
  const row = value as Partial<Receipt>; const binding = bindingFrom(record, threadId); if (!row || typeof row !== 'object' || Object.keys(row).length !== 13 || row.version !== 2 || !sameBinding(row, binding) || typeof row.finalCheckpointId !== 'string' || !/^[A-Za-z0-9-]{16,120}$/.test(row.finalCheckpointId) || typeof row.finalStateFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.finalStateFingerprint) || typeof row.effectObservationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.effectObservationFingerprint) || row.effects !== 1) throw new CorrelationSafetyError('LangGraph receipt is missing or contradicts correlation'); return row as Receipt;
}

/** The ledger creation is the real protected durable effect; observation is a separately persisted proof. */
class EffectSink {
  constructor(private readonly directory: string, private readonly binding: EffectBinding, private readonly checkpoint?: (name: string) => Promise<void>) {}
  async execute(decision: { decision: 'approved' | 'rejected' }): Promise<EffectObservation> {
    if (decision.decision !== this.binding.decision) throw new CorrelationSafetyError('LangGraph effect decision contradicts authoritative evidence'); await this.checkpoint?.('before-protected-effect'); const ledgerStore = new JsonStore<EffectLedger>(this.directory, effectLedgerFilename(this.binding)); let ledger = await ledgerStore.loadOptional();
    if (!ledger) { const proposed: EffectLedger = { version: 1, ...this.binding, effectId: randomUUID() }; ledger = await ledgerStore.createOrLoad(proposed, (value) => validLedger(value, this.binding)); }
    if (!validLedger(ledger, this.binding)) throw new CorrelationSafetyError('LangGraph protected effect ledger is foreign or corrupt'); await this.checkpoint?.('after-protected-effect-before-observation'); await this.checkpoint?.('before-effect-observation'); const observation: EffectObservation = { version: 1, ...this.binding, effectLedgerFingerprint: sha(canonicalJson(ledger)), effects: 1 }; const observationStore = new JsonStore<EffectObservation>(this.directory, effectObservationFilename(this.binding)); const saved = await observationStore.createOrLoad(observation, (value) => validObservation(value, this.binding, ledger)); await this.checkpoint?.('after-effect-observation'); return saved;
  }
  async inspect(): Promise<EffectObservation> { const ledger = await new JsonStore<EffectLedger>(this.directory, effectLedgerFilename(this.binding)).loadRequired('LangGraph protected effect ledger is absent'); if (!validLedger(ledger, this.binding)) throw new CorrelationSafetyError('LangGraph protected effect ledger is foreign or corrupt'); const observation = await new JsonStore<EffectObservation>(this.directory, effectObservationFilename(this.binding)).loadRequired('LangGraph effect observation is absent'); if (!validObservation(observation, this.binding, ledger)) throw new CorrelationSafetyError('LangGraph effect observation is foreign or corrupt'); return observation; }
}

class JsonStore<T> {
  constructor(private readonly directory: string, private readonly filename: string) {}
  async loadOptional(): Promise<T | null> { const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename); try { await safeFile(target); return JSON.parse(await readFile(target, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; if (error instanceof CorrelationSafetyError) throw error; throw new CorrelationSafetyError('LangGraph durable effect artifact is corrupt'); } }
  async loadRequired(message: string): Promise<T> { const value = await this.loadOptional(); if (!value) throw new CorrelationSafetyError(message); return value; }
  async createOrLoad(value: T, validate: (candidate: unknown) => candidate is T): Promise<T> { const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename); const encoded = JSON.stringify(value); try { const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(encoded, 'utf8'); await handle.sync(); } finally { await handle.close(); } await safeFile(target); return value; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const existing = await this.loadRequired('LangGraph durable effect artifact is absent'); if (!validate(existing)) throw new CorrelationSafetyError('LangGraph durable effect artifact contradicts this resume'); return existing; } }
}

function effectLedgerFilename(binding: EffectBinding): string { return `langgraph-effect-ledger-${binding.correlationId}.json`; }
function effectObservationFilename(binding: EffectBinding): string { return `langgraph-effect-observation-${binding.correlationId}.json`; }
function sameBinding(value: Partial<EffectBinding>, binding: EffectBinding): boolean { return value.correlationId === binding.correlationId && value.taskId === binding.taskId && value.requestFingerprint === binding.requestFingerprint && value.operationKey === binding.operationKey && value.threadId === binding.threadId && value.decision === binding.decision && value.messageId === binding.messageId && value.evidenceFingerprint === binding.evidenceFingerprint; }
function validLedger(value: unknown, binding: EffectBinding): value is EffectLedger { const row = value as Partial<EffectLedger>; return !!row && typeof row === 'object' && Object.keys(row).length === 10 && row.version === 1 && sameBinding(row, binding) && typeof row.effectId === 'string' && /^[0-9a-f-]{36}$/.test(row.effectId); }
function validObservation(value: unknown, binding: EffectBinding, ledger: EffectLedger): value is EffectObservation { const row = value as Partial<EffectObservation>; return !!row && typeof row === 'object' && Object.keys(row).length === 11 && row.version === 1 && sameBinding(row, binding) && row.effectLedgerFingerprint === sha(canonicalJson(ledger)) && row.effects === 1; }

class ReceiptStore {
  constructor(private readonly directory: string, private readonly filename: string) {}
  async save(value: Receipt): Promise<void> { const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename); await safeExisting(target); const temporary = contained(directory, `.${this.filename}.${randomUUID()}.tmp`); let created = false; try { const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); } await safeFile(temporary); await safeExisting(target); await rename(temporary, target); created = false; await safeFile(target); } catch (error) { if (created) await removeFile(temporary); throw error; } }
  async load(): Promise<unknown> { try { const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename); await safeFile(target); return JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error instanceof CorrelationSafetyError) throw error; throw new CorrelationSafetyError('LangGraph resume has no valid durable receipt'); } }
}
/** The effect receipt is bound to the correlation, never shared by another graph thread. */
export function langGraphReceiptFilename(correlationId: string): string { return `langgraph-receipt-${correlationId}.json`; }
function receiptFilename(record: CorrelationRecord): string { return langGraphReceiptFilename(record.correlationId); }
async function trustedDirectory(directory: string): Promise<string> { await mkdir(directory, { recursive: true, mode: 0o700 }); const entry = await lstat(directory); if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid() || (entry.mode & 0o777) !== 0o700) throw new CorrelationSafetyError('LangGraph SQLite directory must be owner-owned mode 0700'); return realpath(directory); }
function contained(directory: string, filename: string): string { if (!filename || filename === '.' || filename === '..' || basename(filename) !== filename || isAbsolute(filename) || /[\\/]|%2e|%2f/i.test(filename)) throw new CorrelationSafetyError('LangGraph state filename is unsafe'); const target = resolve(directory, filename); if (target === directory || !target.startsWith(`${directory}/`)) throw new CorrelationSafetyError('LangGraph state path escapes its trusted directory'); return target; }
async function ensureDatabaseFile(path: string): Promise<void> { try { await safeFile(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.close(); await safeFile(path); }
async function validateSqliteArtifacts(directory: string): Promise<void> { for (const name of [DB_FILENAME, `${DB_FILENAME}-wal`, `${DB_FILENAME}-shm`, `${DB_FILENAME}-journal`]) { const path = contained(directory, name); try { await safeFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } }
async function safeExisting(path: string): Promise<void> { try { await safeFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
async function safeFile(path: string): Promise<void> { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid() || (entry.mode & 0o777) !== 0o600 || !(await stat(path)).isFile()) throw new CorrelationSafetyError('LangGraph SQLite artifact must be owner-owned regular mode 0600'); }
async function removeFile(path: string): Promise<void> { try { const entry = await lstat(path); if (entry.isFile() && !entry.isSymbolicLink()) await unlink(path); } catch { /* owned temporary only */ } }
function uid(): number { const value = process.getuid?.(); if (value === undefined) throw new CorrelationSafetyError('owner validation unavailable'); return value; }
