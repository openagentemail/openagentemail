/**
 * 写出超过管道容量的填充字节；等双流写回调与 drain 都成功后再自然退出。
 * 填充不含凭证。禁止未 flush 就 process.exit。
 */
const bytes = Number(process.env.LIST_RATE_VERBOSE_BYTES ?? String(128 * 1024));
const chunk = 'v'.repeat(1024);
const n = Math.max(1, Math.ceil(bytes / chunk.length));
const payload = chunk.repeat(n);

/** 等本次 write 回调成功；若仍需排空则再等 drain。 */
async function writeFully(stream: NodeJS.WriteStream, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  if (stream.writableNeedDrain) {
    await new Promise<void>((resolve) => {
      stream.once('drain', resolve);
    });
  }
}

await Promise.all([
  writeFully(process.stdout, `${payload}\nVERBOSE_OK bytes=${payload.length}\n`),
  writeFully(process.stderr, `${payload}\nVERBOSE_ERR_OK bytes=${payload.length}\n`),
]);
// 双流已确认写完，自然退出，不调用 process.exit。
