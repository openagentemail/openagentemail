/**
 * 回归：Bun.serve 默认 idleTimeout=10s 会掐断无字节长连接（公网 mail_wait_for 实测 502）。
 * 生产保留全局 10s；仅对长轮询路径 server.timeout(req, 0)。
 */
import { describe, expect, test } from 'bun:test';

const MAIN_PATH = new URL('../src/main.ts', import.meta.url);

/** 从 main.ts 的 default export 钉死生产 idleTimeout，避免误测一份手写副本。 */
async function readProductionIdleTimeout(): Promise<number> {
  const src = await Bun.file(MAIN_PATH).text();
  // 只认 export default 对象里的 idleTimeout，防止注释/其它字面量误匹配。
  const match = src.match(/export default\s*\{[\s\S]*?\bidleTimeout:\s*(\d+)\b/);
  if (!match) {
    throw new Error('packages/api/src/main.ts default export 缺少 idleTimeout');
  }
  return Number(match[1]);
}

/** 钉死生产 fetch 对长轮询调用了 server.timeout(req, 0)。 */
async function productionDisablesTimeoutPerLongPoll(): Promise<boolean> {
  const src = await Bun.file(MAIN_PATH).text();
  return (
    src.includes('isLongPollRequest') &&
    /server\.timeout\(\s*req\s*,\s*0\s*\)/.test(src)
  );
}

/**
 * 起一个只 sleep、期间不写任何响应字节的本地服务，模拟 wait 类长连接。
 * disableIdle 为 true 时按生产路径调用 server.timeout(req, 0)。
 */
async function requestSilentWait(
  idleTimeout: number,
  silentMs: number,
  disableIdle = false,
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout,
    fetch: async (req, srv) => {
      // 故意不先写字节：复现「handler 仍在跑、连接被 server 层掐」的现场。
      if (disableIdle) srv.timeout(req, 0);
      await Bun.sleep(silentMs);
      return new Response('still-alive');
    },
  });
  try {
    const res = await fetch(server.url);
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    server.stop(true);
  }
}

describe('Bun.serve idleTimeout（长连接不被 server 层掐断）', () => {
  test('生产保留全局 idleTimeout=10，长轮询按请求 server.timeout(req, 0)', async () => {
    expect(await readProductionIdleTimeout()).toBe(10);
    expect(await productionDisablesTimeoutPerLongPoll()).toBe(true);
  });

  test('对照：idleTimeout=2 且无按请求豁免时，约 4s 无字节会被掐断', async () => {
    const result = await requestSilentWait(2, 4_000, false);
    expect(result.ok).toBe(false);
    expect(result.body).not.toBe('still-alive');
  }, 15_000);

  test('生产路径：全局 10s + server.timeout(req, 0) 时，15s+ 无字节仍能完成', async () => {
    const idleTimeout = await readProductionIdleTimeout();
    expect(idleTimeout).toBe(10);
    expect(await productionDisablesTimeoutPerLongPoll()).toBe(true);
    const started = Date.now();
    const result = await requestSilentWait(idleTimeout, 16_000, true);
    const elapsedMs = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe('still-alive');
    expect(elapsedMs).toBeGreaterThanOrEqual(15_000);
  }, 25_000);
});
