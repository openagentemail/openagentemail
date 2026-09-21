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
    const firstStarted = Promise.withResolvers<void>();

    // 第一席：占住锁
    const gate = Promise.withResolvers<void>();
    const first = seats.run('term_a', async () => {
      order.push('first-start');
      firstStarted.resolve();
      await gate.promise;
      order.push('first-done');
      return 'first';
    });

    await firstStarted.promise;
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
    const firstWakeStarted = Promise.withResolvers<void>();
    const woken: string[] = [];
    const wake: WakeFn = async (req) => {
      // 从 argv 文本里抽 event id 不便；用调用序 + 闭包计数
      woken.push(req.text);
      if (woken.length === 1) firstWakeStarted.resolve();
      await gate;
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };

    // 故意违反 headroom（requestTimeoutMs >= sendTimeoutMs+2000）以触发排队超时，勿当可运行配置样例
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
    await firstWakeStarted.promise;
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

    // r1 先注册计时器且 await p2 已保证其 120ms deadline 先 fire（wake 挂 gate 时响应未写）：
    // 计时器写 503 后 headersSent=true，wake 完成路径的 writeJson 被 :103 守卫拦——终态确定
    expect(r1.status).toBe(503);
    expect(r1.json.reason).toBe('request_timeout');
  });

  test('正例：排队等待短于 request_timeout 时第二事件照常执行', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstWakeStarted = Promise.withResolvers<void>();
    let wakes = 0;
    const wake: WakeFn = async (req) => {
      wakes += 1;
      if (wakes === 1) {
        firstWakeStarted.resolve();
        await gate;
      }
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
    await firstWakeStarted.promise;
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

describe('dedup.share waiter aggregate (#229 P1-1)', () => {
  test('同 key 两请求重叠排队：首请求 request_timeout 不连坐，第二请求照常完成', async () => {
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holdWakeStarted = Promise.withResolvers<void>();
    const woken: string[] = [];
    const wake: WakeFn = async (req) => {
      woken.push(req.text);
      // 首个占席事件阻塞；共享 key 的事件开跑后立即完成
      if (woken.length === 1) {
        holdWakeStarted.resolve();
        await holdGate;
      }
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };

    // 故意违反 headroom（requestTimeoutMs >= sendTimeoutMs+2000）以触发排队超时，勿当可运行配置样例
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', requestTimeoutMs: 150, sendTimeoutMs: 800 }),
      { wake },
    );
    receivers.push(receiver);

    // 占住同 terminal 席锁（distinct key）
    const holdBody = mailBody({ id: 'evt_hold0001-2222-3333-4444-555555555555' });
    const pHold = postHook(receiver, { body: holdBody });
    await holdWakeStarted.promise;
    expect(woken).toHaveLength(1);

    const sharedBody = mailBody({
      id: 'evt_shared01-2222-3333-4444-555555555555',
      data: { address: 'alice@openagent.email', messageId: 'shared-1' },
    });
    // 首个同 key 请求先入队（将先 timeout）
    const pFirst = postHook(receiver, { body: sharedBody });
    await Bun.sleep(40);
    // 第二同 key 请求加入 waiter 集合（自身 deadline 更晚）
    const pSecond = postHook(receiver, { body: sharedBody });

    const rFirst = await pFirst;
    expect(rFirst.status).toBe(503);
    expect(rFirst.json.reason).toBe('request_timeout');
    // 首请求超时不得弃掉共享 work：尚未 spawn shared 事件
    expect(woken).toHaveLength(1);

    releaseHold();
    const rSecond = await pSecond;
    // 第二请求应完成（submitted 或 duplicate——share 单次 wake）
    expect(rSecond.status).toBe(200);
    expect(['submitted', 'duplicate']).toContain(rSecond.json.disposition);
    const deadline = Date.now() + 2000;
    while (woken.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(woken).toHaveLength(2);
    expect(receiver.metrics.submitted).toBeGreaterThanOrEqual(2);

    await pHold;
  });

  test('同 key 全部 waiter 超时 → 共享 work 弃队（wake 未 spawn、dedup 键未消费）', async () => {
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holdWakeStarted = Promise.withResolvers<void>();
    const woken: string[] = [];
    const wake: WakeFn = async (req) => {
      woken.push(req.text);
      if (woken.length === 1) {
        holdWakeStarted.resolve();
        await holdGate;
      }
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };

    // 故意违反 headroom（requestTimeoutMs >= sendTimeoutMs+2000）以触发排队超时，勿当可运行配置样例
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', requestTimeoutMs: 80, sendTimeoutMs: 800 }),
      { wake },
    );
    receivers.push(receiver);

    const holdBody = mailBody({ id: 'evt_hold0002-2222-3333-4444-555555555555' });
    const pHold = postHook(receiver, { body: holdBody });
    await holdWakeStarted.promise;
    expect(woken).toHaveLength(1);

    const sharedBody = mailBody({
      id: 'evt_shared02-2222-3333-4444-555555555555',
      data: { address: 'alice@openagent.email', messageId: 'shared-2' },
    });
    const pA = postHook(receiver, { body: sharedBody });
    const pB = postHook(receiver, { body: sharedBody });
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.status).toBe(503);
    expect(rB.status).toBe(503);
    expect(rA.json.reason).toBe('request_timeout');
    expect(rB.json.reason).toBe('request_timeout');
    // 全部 waiter 超时 → 共享排队弃队，shared 事件不得 spawn
    expect(woken).toHaveLength(1);

    releaseHold();
    await pHold;
    const afterHold = Date.now() + 500;
    while (Date.now() < afterHold) {
      await Bun.sleep(20);
      expect(woken).toHaveLength(1);
    }
    // dedup 键未消费：重试走首验并成功提交
    const retry = await postHook(receiver, { body: sharedBody });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(woken).toHaveLength(2);
  });

  test('阴性对照：单请求（无其他 waiter）超时 → 仍须正常弃队', async () => {
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holdWakeStarted = Promise.withResolvers<void>();
    const woken: string[] = [];
    const wake: WakeFn = async (req) => {
      woken.push(req.text);
      if (woken.length === 1) {
        holdWakeStarted.resolve();
        await holdGate;
      }
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };

    // 故意违反 headroom（requestTimeoutMs >= sendTimeoutMs+2000）以触发排队超时，勿当可运行配置样例
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', requestTimeoutMs: 100, sendTimeoutMs: 800 }),
      { wake },
    );
    receivers.push(receiver);

    const holdBody = mailBody({ id: 'evt_hold0003-2222-3333-4444-555555555555' });
    const pHold = postHook(receiver, { body: holdBody });
    await holdWakeStarted.promise;
    expect(woken).toHaveLength(1);

    const soloBody = mailBody({
      id: 'evt_solo0001-2222-3333-4444-555555555555',
      data: { address: 'alice@openagent.email', messageId: 'solo-1' },
    });
    const pSolo = postHook(receiver, { body: soloBody });
    const rSolo = await pSolo;
    expect(rSolo.status).toBe(503);
    expect(rSolo.json.reason).toBe('request_timeout');
    // 单 waiter 走光 → 聚合 abort → 排队弃队：solo 不得 spawn
    expect(woken).toHaveLength(1);
    expect(receiver.metrics.shareAbandoned).toBeGreaterThanOrEqual(1);

    releaseHold();
    await pHold;
    await Bun.sleep(80);
    expect(woken).toHaveLength(1);

    // dedup 键未消费：重试走首验
    const retry = await postHook(receiver, { body: soloBody });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(woken).toHaveLength(2);
  });
});
