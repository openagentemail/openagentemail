/**
 * 回归：Bun.serve 默认 idleTimeout=10s 会掐断无字节长连接（公网 mail_wait_for 实测 502）。
 * 生产 serve 配置必须显式 idleTimeout: 0；本文件用真 Bun.serve 验证 >15s 静默仍能完成。
 *
 * 对照不写死掐断秒数：CI bun 1.2.21 与本机 1.3.x 的定时器粒度不同，
 * handler 若在 ~2×idleTimeout 时刚好 return，会和掐线抢跑（GH job 95079538125）。
 * handler 挂住超过观察窗，客户端等「最终被掐」，断言发生在 idleTimeout 之后、上限之前。
 */
import { describe, expect, test } from 'bun:test';

const MAIN_PATH = new URL('../src/main.ts', import.meta.url);

/** 从 main.ts 的 default export 钉死生产 idleTimeout，避免误测一份手写副本。 */
async function readProductionIdleTimeout(): Promise<number> {
  const src = await Bun.file(MAIN_PATH).text();
  // 只切 export default 到首个 `};`，避免误捕块外同名键。
  const block = src.match(/export default\s*\{[\s\S]*?\};/);
  if (!block) {
    throw new Error('packages/api/src/main.ts 缺少 export default 块');
  }
  const match = block[0].match(/\bidleTimeout:\s*(\d+)\b/);
  if (!match) {
    throw new Error('packages/api/src/main.ts default export 缺少 idleTimeout');
  }
  return Number(match[1]);
}

function isClientCeilingAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
}

/**
 * 起一个只 sleep、期间不写任何响应字节的本地服务，模拟 wait 类长连接。
 * clientCeilingMs 防止 runner 上永不掐线时挂死；触顶视为未打到 server 层。
 */
async function requestSilentWait(
  idleTimeout: number,
  silentMs: number,
  clientCeilingMs?: number,
): Promise<{
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  elapsedMs: number;
  clientCeiling: boolean;
}> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout,
    fetch: async () => {
      // 故意不先写字节：复现「handler 仍在跑、连接被 server 层掐」的现场。
      await Bun.sleep(silentMs);
      return new Response('still-alive');
    },
  });
  const started = Date.now();
  try {
    const res = await fetch(server.url, {
      signal: clientCeilingMs ? AbortSignal.timeout(clientCeilingMs) : undefined,
    });
    return {
      ok: res.ok,
      status: res.status,
      body: await res.text(),
      elapsedMs: Date.now() - started,
      clientCeiling: false,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err),
      elapsedMs: Date.now() - started,
      clientCeiling: isClientCeilingAbort(err),
    };
  } finally {
    server.stop(true);
  }
}

describe('Bun.serve idleTimeout（长连接不被 server 层掐断）', () => {
  test('生产 serve 配置显式 idleTimeout: 0（禁用）', async () => {
    expect(await readProductionIdleTimeout()).toBe(0);
  });

  test('对照：有限 idleTimeout 时连接在超时之后、15s 上限之前被 server 层掐断', async () => {
    const idleSec = 2;
    const ceilingMs = 15_000;
    // handler 挂住超过观察窗，避免「刚好 return」和掐线抢跑。
    const result = await requestSilentWait(idleSec, 20_000, ceilingMs);
    expect(result.clientCeiling).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.body).not.toBe('still-alive');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(idleSec * 1_000);
    expect(result.elapsedMs).toBeLessThan(ceilingMs);
  }, 25_000);

  test('生产值 idleTimeout=0：15s+ 无字节长连接仍能正常完成', async () => {
    const idleTimeout = await readProductionIdleTimeout();
    expect(idleTimeout).toBe(0);
    const result = await requestSilentWait(idleTimeout, 16_000);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe('still-alive');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(15_000);
  }, 25_000);
});
