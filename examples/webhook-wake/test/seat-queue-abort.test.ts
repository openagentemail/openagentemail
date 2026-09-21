import { afterEach, describe, expect, test } from 'bun:test';
import { SEAT_QUEUE_ABORTED, SeatSerializer } from '../src/serialize.ts';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeFn } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('SeatSerializer queue abort (#229)', () => {
  test('排队段 abort 弃队且不执行 work；已开跑 work 不因后续 abort 打断', async () => {
    const seats = new SeatSerializer();
    const order: string[] = [];

    // 第一席：占住锁
    const gate = Promise.withResolvers<void>();
    const first = seats.run('term_a', async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-done');
      return 'first';
    });

    // 等第一席真正开跑
    for (let i = 0; i < 50 && !order.includes('first-start'); i += 1) {
      await Bun.sleep(5);
    }
    expect(order).toEqual(['first-start']);

    // 第二席：排队中 abort → 弃队
    const ac = new AbortController();
    const second = seats.run(
      'term_a',
      async () => {
        order.push('second-run');
        return 'second';
      },
      ac.signal,
    );
    await Bun.sleep(20);
    ac.abort();
    await expect(second).rejects.toMatchObject({ code: SEAT_QUEUE_ABORTED });
    expect(order).toEqual(['first-start']);

    // 第一席开跑后 abort 其 signal 不影响（本例第一席无 signal）；放行后完成
    gate.resolve();
    expect(await first).toBe('first');
    expect(order).toEqual(['first-start', 'first-done']);
  });

  test('弃队后下一位仍可在 prev 完成后开跑', async () => {
    const seats = new SeatSerializer();
    const gate = Promise.withResolvers<void>();
    const first = seats.run('term_b', async () => {
      await gate.promise;
      return 1;
    });
    const ac = new AbortController();
    const abandoned = seats.run('term_b', async () => 2, ac.signal);
    await Bun.sleep(10);
    ac.abort();
    await expect(abandoned).rejects.toMatchObject({ code: SEAT_QUEUE_ABORTED });
    const third = seats.run('term_b', async () => 3);
    gate.resolve();
    expect(await first).toBe(1);
    expect(await third).toBe(3);
  });
});

describe('seat-queue vs request_timeout (#229)', () => {
  test('阴性：同 terminal 两并发 distinct 事件，第二请求 request_timeout → 未 spawn、首事件提交、duplicates 只反映首事件', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const woken: string[] = [];
    const wake: WakeFn = async (req) => {
      // 从 argv 文本里抽 event id 不便；用调用序 + 闭包计数
      woken.push(req.text);
      await gate;
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };

    const receiver = await startReceiver(
      testConfig({ mode: 'canary', requestTimeoutMs: 120, sendTimeoutMs: 800 }),
      { wake },
    );
    receivers.push(receiver);

    const body1 = mailBody({ id: 'evt_aaaaaaa1-2222-3333-4444-555555555555' });
    const body2 = mailBody({
      id: 'evt_bbbbbbb2-2222-3333-4444-555555555555',
      data: { address: 'alice@openagent.email', messageId: '456' },
    });

    const p1 = postHook(receiver, { body: body1 });
    // 等第一事件占住席锁再发第二
    for (let i = 0; i < 80 && woken.length === 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(woken).toHaveLength(1);

    const p2 = postHook(receiver, { body: body2 });
    const r2 = await p2;
    expect(r2.status).toBe(503);
    expect(r2.json.reason).toBe('request_timeout');
    // 第二事件不得 spawn
    expect(woken).toHaveLength(1);

    release();
    const r1 = await p1;
    // 首事件可能已先被写 503（request_timeout），但 send 仍完成提交
    const deadline = Date.now() + 2000;
    while (receiver.metrics.submitted < 1 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(receiver.metrics.submitted).toBe(1);
    expect(woken).toHaveLength(1);
    // duplicates 只反映首事件后续重试，不因第二事件虚记
    expect(receiver.metrics.duplicates).toBe(0);

    // 同 envelope.id 重试走首验 / duplicate（弃队未消费 dedup 键——仅第二事件）
    const retry2 = await postHook(receiver, { body: body2 });
    expect(retry2.status).toBe(200);
    expect(retry2.json.disposition).toBe('submitted');
    expect(woken).toHaveLength(2);
    expect(receiver.metrics.submitted).toBe(2);

    const retry1 = await postHook(receiver, { body: body1 });
    expect(retry1.status).toBe(200);
    expect(retry1.json.disposition).toBe('duplicate');
    expect(receiver.metrics.duplicates).toBe(1);
    expect(woken).toHaveLength(2);

    // r1 可能是 503（超时已写）或竞态下 200；不把写响应当作验收点
    expect([200, 503]).toContain(r1.status);
  });

  test('正例：排队等待短于 request_timeout 时第二事件照常执行', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wakes = 0;
    const wake: WakeFn = async (req) => {
      wakes += 1;
      if (wakes === 1) await gate;
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };

    const receiver = await startReceiver(
      testConfig({ mode: 'canary', requestTimeoutMs: 4000, sendTimeoutMs: 800 }),
      { wake },
    );
    receivers.push(receiver);

    const body1 = mailBody({ id: 'evt_ccccccc1-2222-3333-4444-555555555555' });
    const body2 = mailBody({
      id: 'evt_ddddddd2-2222-3333-4444-555555555555',
      data: { address: 'alice@openagent.email', messageId: '789' },
    });

    const p1 = postHook(receiver, { body: body1 });
    for (let i = 0; i < 80 && wakes === 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(wakes).toBe(1);
    const p2 = postHook(receiver, { body: body2 });
    // 短等后放行，第二事件应在超时前开跑
    await Bun.sleep(30);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.disposition).toBe('submitted');
    expect(r2.json.disposition).toBe('submitted');
    expect(wakes).toBe(2);
    expect(receiver.metrics.submitted).toBe(2);
    expect(receiver.metrics.duplicates).toBe(0);
  });
});
