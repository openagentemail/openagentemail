import { PHASES, isSafeTaskId, validateCorrelationRecord, type CorrelationRecord, type Phase } from './correlation-store.js';
import type { TaskState } from './openagentemail.js';

const STATES = new Set<TaskState>(['submitted', 'working', 'input-required', 'completed', 'failed']);
const CODES = new Set(['create-failed', 'reconcile-failed', 'input-failed', 'decision-failed', 'resume-failed', 'timeout', 'conflict']);
export interface TimelineEvent { at: string; phase: Phase; code: string; taskId?: string; state?: TaskState; }

/** Allowlisted diagnostics reject unsafe values as well as stripping unknown keys. */
export function sanitizedTimeline(record: CorrelationRecord, events: readonly TimelineEvent[]): object {
  validateCorrelationRecord(record);
  return {
    correlationId: record.correlationId, operationKey: record.operationKey, taskId: record.taskId, phase: record.phase,
    events: events.map((event) => {
      if (!canonicalTime(event.at) || !PHASES.includes(event.phase) || !CODES.has(event.code) || (event.state !== undefined && !STATES.has(event.state)) || (event.taskId !== undefined && !isSafeTaskId(event.taskId))) throw new Error('unsafe timeline event');
      return { at: event.at, phase: event.phase, code: event.code, ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.state ? { state: event.state } : {}) };
    }),
  };
}

function canonicalTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
