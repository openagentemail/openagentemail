/**
 * 回归：Bun.serve 默认 idleTimeout=10s 会掐断无字节长连接（公网 mail_wait_for 实测 502）。
 * 生产 serve 配置必须显式 idleTimeout: 0；本文件用真 Bun.serve 验证 >15s 静默仍能完成。
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

/**
 * 起一个只 sleep、期间不写任何响应字节的本地服务，模拟 wait 类长连接。
 * 返回 fetch 结果；被 idleTimeout 掐断时走 catch。
 */
async function requestSilentWait(
  idleTimeout: number,
  silentMs: number,
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
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
  test('生产 serve 配置显式 idleTimeout: 0（禁用）', async () => {
    expect(await readProductionIdleTimeout()).toBe(0);
  });

  test('对照：idleTimeout=2 时约 4s 无字节会被掐断（证明本测试打到 server 层）', async () => {
    const result = await requestSilentWait(2, 4_000);
    expect(result.ok).toBe(false);
    expect(result.body).not.toBe('still-alive');
  }, 15_000);

  test('生产值 idleTimeout=0：15s+ 无字节长连接仍能正常完成', async () => {
    const idleTimeout = await readProductionIdleTimeout();
    expect(idleTimeout).toBe(0);
    const started = Date.now();
    const result = await requestSilentWait(idleTimeout, 16_000);
    const elapsedMs = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe('still-alive');
    expect(elapsedMs).toBeGreaterThanOrEqual(15_000);
  }, 25_000);
});
