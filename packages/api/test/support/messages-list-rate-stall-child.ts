/** 仅用于父包装超时回收证明；不加载业务模块。 */
const stallMs = Number(process.env.LIST_RATE_STALL_MS ?? 0);
if (stallMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, stallMs));
}
process.exit(0);
