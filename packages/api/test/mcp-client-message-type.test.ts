// 客户端详情类型要对齐服务端 MessageDetail 的线程字段。
// 列表摘要不能有这两项：列表和 webhook 都不带它们。
import { expect, test } from 'bun:test';
import type { Message, MessageSummary } from '../src/mcp/client.ts';

type Has<T, K extends string> = K extends keyof T ? true : false;
type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

test('客户端 Message 有可选 messageId/references，MessageSummary 没有', () => {
  // 字段缺失或类型不对，这里会在 tsc 报错。
  const detailHasMessageId: Has<Message, 'messageId'> = true;
  const detailHasReferences: Has<Message, 'references'> = true;
  const messageIdType: Eq<Message['messageId'], string | undefined> = true;
  const referencesType: Eq<Message['references'], string[] | undefined> = true;
  const summaryHasMessageId: Has<MessageSummary, 'messageId'> = false;
  const summaryHasReferences: Has<MessageSummary, 'references'> = false;

  const detail = {
    id: '7',
    from: 'a@example.com',
    to: 'b@example.com',
    subject: 's',
    date: '2026-10-28T00:00:00.000Z',
    seen: false,
    snippet: 'hi',
    text: 'hi',
    otp: { codes: [] as string[], links: [] as string[] },
    messageId: '<self@example.com>',
    references: ['<prev@example.com>'],
  } satisfies Message;

  expect(detailHasMessageId && detailHasReferences).toBe(true);
  expect(messageIdType && referencesType).toBe(true);
  expect(summaryHasMessageId || summaryHasReferences).toBe(false);
  expect(detail.messageId).toBe('<self@example.com>');
  expect(detail.references).toEqual(['<prev@example.com>']);
});
