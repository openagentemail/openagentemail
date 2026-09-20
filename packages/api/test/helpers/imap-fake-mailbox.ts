/**
 * #201：共享 IMAP fake 信箱态——uidValidity 可注入，默认 17n 保现有业务断言。
 * 仅供测试 fixture 复用；不触及 missing/malformed 专用负控路径。
 */

/** 默认代际：与历史 FakeImapFlow 常量对齐。 */
export const DEFAULT_FAKE_UID_VALIDITY = 17n;

export type FakeMailboxStateOptions = {
  /** 注入的 UIDVALIDITY；缺省 = 17n。 */
  uidValidity?: bigint;
};

/**
 * 构造只读 mailbox 快照（供 FakeImapFlow.mailbox getter 返回）。
 */
export function createFakeMailboxState(options: FakeMailboxStateOptions = {}): { uidValidity: bigint } {
  return { uidValidity: options.uidValidity ?? DEFAULT_FAKE_UID_VALIDITY };
}

/**
 * 可变注入版：测试内可改 uidValidity，复位到默认 17n。
 * 三文件 FakeImapFlow 共用此控制器，避免各文件再硬编码常量。
 */
export function createConfigurableFakeMailbox(initial: bigint = DEFAULT_FAKE_UID_VALIDITY) {
  let uidValidity = initial;
  return {
    /** 与 ImapFlow 选中会话 mailbox 同形。 */
    get mailbox(): { uidValidity: bigint } {
      return { uidValidity };
    },
    /** 注入非默认代际（#201 复用示范入口）。 */
    setUidValidity(next: bigint): void {
      uidValidity = next;
    },
    /** 复位到默认 17n，避免用例间串扰。 */
    resetUidValidity(): void {
      uidValidity = DEFAULT_FAKE_UID_VALIDITY;
    },
    /** 只读当前注入值。 */
    getUidValidity(): bigint {
      return uidValidity;
    },
  };
}

export type ConfigurableFakeMailbox = ReturnType<typeof createConfigurableFakeMailbox>;
