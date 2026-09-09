import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import type { SendInput } from '../../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../../src/lib/tasks.ts';
import {
  setPostSmtpAcceptHookForTests,
  setPreSmtpHookForTests,
} from './task-lease-seams.ts';
import {
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} from './task-test-seams.ts';
import { claimTask, taskFromMessages } from '../../src/lib/tasks.ts';

const args = new Map<string, string>();
for (const arg of process.argv) {
  if (arg.startsWith('--')) {
    const [k, ...rest] = arg.slice(2).split('=');
    if (k && rest.length > 0) {
      args.set(k, rest.join('='));
    }
  }
}

const mode = args.get('mode') ?? process.env.SIGKILL_MODE ?? '';
const taskId = args.get('task-id') ?? process.env.SIGKILL_TASK_ID ?? '';
const dataDir = args.get('data-dir') ?? process.env.DATA_DIR ?? '';
const syncFifo = args.get('sync-fifo') ?? process.env.SYNC_FIFO ?? '';
const pauseFifo = args.get('pause-fifo') ?? process.env.PAUSE_FIFO ?? '';
const barrierFile = args.get('barrier-file') ?? process.env.BARRIER_FILE ?? '';
const sentFile = args.get('sent-file') ?? process.env.SENT_FILE ?? '';
const resultFile = args.get('result-file') ?? process.env.RESULT_FILE ?? '';

const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(id: string): RawTaskMessage {
  return {
    uid: 1,
    from: A,
    to: B,
    subject: `Lease ${id}`,
    date: '2026-08-24T00:00:00.000Z',
    state: 'submitted',
    body: 'Please claim.',
  };
}

function submittedTask(id: string): Task {
  return taskFromMessages(id, [submittedRaw(id)])!;
}

function writeBarrier(record: { stage: string; payloadHash: string; generation: number }): void {
  const fd = openSync(barrierFile, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function signalSyncFifo(): void {
  const syncFd = openSync(syncFifo, constants.O_WRONLY);
  closeSync(syncFd);
}

function blockOnPauseFifo(): void {
  const pauseFd = openSync(pauseFifo, constants.O_RDONLY);
  readSync(pauseFd, Buffer.alloc(1));
}

function recordSentMail(input: SendInput): void {
  appendFileSync(sentFile, JSON.stringify(input) + '\n');
}

function getHeader(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

async function run(): Promise<void> {
  const task = submittedTask(taskId);
  setTaskNowForTests(() => START);
  setTaskGetForTests(async () => task);
  setTaskListAllForTests(async () => [task]);

  if (mode === 'case-a-child-1') {
    setTaskSendMailForTests(async (input) => {
      recordSentMail(input);
      return { messageId: 'smtp-accept-1' };
    });

    setPostSmtpAcceptHookForTests(async (rec) => {
      const payloadHash = createHash('sha256').update(rec.signedPayload ?? '').digest('hex');
      writeBarrier({
        stage: 'at-smtp-accept-pre-fate',
        payloadHash,
        generation: rec.generation,
      });
      signalSyncFifo();
      blockOnPauseFifo();
    });

    await claimTask({ id: taskId, from: B, leaseSec: 300 });
    return;
  }

  if (mode === 'case-a-child-2') {
    setTaskSendMailForTests(async (input) => {
      recordSentMail(input);
      return { messageId: 'smtp-accept-2' };
    });

    let threw409 = false;
    let errorMessage = '';
    try {
      await claimTask({ id: taskId, from: B, leaseSec: 300 });
    } catch (err: unknown) {
      errorMessage = (err as Error).message;
      if (errorMessage === 'lease_overlay_pending_index') {
        threw409 = true;
      }
    }

    if (!threw409) {
      throw new Error(`Expected lease_overlay_pending_index (409), got error: ${errorMessage}`);
    }

    // Read sent records from both Child 1 and Child 2
    const lines = readFileSync(sentFile, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length < 2) {
      throw new Error(`Expected at least 2 sent emails (first attempt + resend), found ${lines.length}`);
    }
    const sent1 = JSON.parse(lines[0]!) as SendInput;
    const sent2 = JSON.parse(lines[1]!) as SendInput;

    const payload1 = getHeader(sent1.headers, 'x-oa-task-lease-payload');
    const payload2 = getHeader(sent2.headers, 'x-oa-task-lease-payload');
    const stamp1 = getHeader(sent1.headers, 'x-oa-task-stamp');
    const stamp2 = getHeader(sent2.headers, 'x-oa-task-stamp');

    if (!payload1 || !payload2 || payload1 !== payload2) {
      throw new Error(`Payload mismatch: first=${payload1} second=${payload2}`);
    }
    if (!stamp1 || !stamp2 || stamp1 !== stamp2) {
      throw new Error(`Stamp mismatch: first=${stamp1} second=${stamp2}`);
    }

    const payloadObj = JSON.parse(Buffer.from(payload2, 'base64url').toString('utf8')) as { generation: number };
    if (payloadObj.generation !== 1) {
      throw new Error(`Allocated unexpected generation: ${payloadObj.generation}`);
    }

    const result = {
      success: true,
      byteIdentical: true,
      noNPlusOne: true,
      fenceHeld: true,
      generation: payloadObj.generation,
    };
    writeFileSync(resultFile, JSON.stringify(result) + '\n');
    process.exit(0);
  }

  if (mode === 'case-b-child-1') {
    setTaskSendMailForTests(async (input) => {
      recordSentMail(input);
      return { messageId: 'smtp-accept-b-1' };
    });

    setPreSmtpHookForTests(async (rec) => {
      const payloadHash = createHash('sha256').update(rec.signedPayload ?? '').digest('hex');
      writeBarrier({
        stage: 'intent',
        payloadHash,
        generation: rec.generation,
      });
      signalSyncFifo();
      blockOnPauseFifo();
    });

    await claimTask({ id: taskId, from: B, leaseSec: 300 });
    return;
  }

  if (mode === 'case-b-child-2') {
    setTaskSendMailForTests(async (input) => {
      recordSentMail(input);
      return { messageId: 'smtp-accept-b-2' };
    });

    let threw409 = false;
    let errorMessage = '';
    try {
      await claimTask({ id: taskId, from: B, leaseSec: 300 });
    } catch (err: unknown) {
      errorMessage = (err as Error).message;
      if (errorMessage === 'lease_overlay_pending_index') {
        threw409 = true;
      }
    }

    if (!threw409) {
      throw new Error(`Expected lease_overlay_pending_index (409), got error: ${errorMessage}`);
    }

    const lines = readFileSync(sentFile, 'utf8').trim().split('\n').filter(Boolean);
    // In Case B, Child 1 was killed before SMTP, so sentFile only has Child 2's resend
    if (lines.length < 1) {
      throw new Error(`Expected at least 1 sent email from resend, found ${lines.length}`);
    }
    const resent = JSON.parse(lines[0]!) as SendInput;
    const payload = getHeader(resent.headers, 'x-oa-task-lease-payload');
    if (!payload) throw new Error('Missing x-oa-task-lease-payload header on resend');
    const payloadObj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { generation: number };
    if (payloadObj.generation !== 1) {
      throw new Error(`Allocated unexpected generation: ${payloadObj.generation}`);
    }

    const result = {
      success: true,
      fenceHeld: true,
      noNPlusOne: true,
      generation: payloadObj.generation,
    };
    writeFileSync(resultFile, JSON.stringify(result) + '\n');
    process.exit(0);
  }

  throw new Error(`Unknown mode: ${mode}`);
}

run().catch((err: unknown) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
