/**
 * 便宜、确定的 reset 约定探测：只导入限速模块，不打 HTTP/IMAP。
 * 输出一行 JSON，不含凭证。
 */
const {
  LIST_MESSAGES_LIMIT,
  checkListMessagesLimit,
  listMessagesBucketCountForTests,
  resetRateLimits,
} = await import('../../src/lib/ratelimit.ts');

const key = 'list:id:reset-probe@test.example';
const now = 2_000_000;
for (let i = 0; i < LIST_MESSAGES_LIMIT; i++) {
  checkListMessagesLimit(key, now);
}
const afterFill = checkListMessagesLimit(key, now);
const sizeAfterFill = listMessagesBucketCountForTests();
resetRateLimits();
const sizeAfterCommon = listMessagesBucketCountForTests();
const afterCommon = checkListMessagesLimit(key, now);

const report = {
  afterFillAllowed: afterFill.allowed,
  sizeAfterFill,
  sizeAfterCommonReset: sizeAfterCommon,
  afterCommonResetAllowed: afterCommon.allowed,
  commonResetClearsList: sizeAfterCommon === 0 && afterFill.allowed === false && afterCommon.allowed === true,
};
console.log(JSON.stringify(report));
process.exit(0);
