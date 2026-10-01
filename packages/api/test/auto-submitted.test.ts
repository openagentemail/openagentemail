// #363-B：有界 Auto-Submitted。不连真实 IMAP、SMTP 或 webhook 端点。
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';

import { describe, expect, test } from 'bun:test';
import { simpleParser } from 'mailparser';

const { classifyAutoSubmitted } = await import('../src/lib/auto-submitted.ts');
const { config } = await import('../src/lib/config.ts');
const { toDetail } = await import('../src/lib/imap.ts');
const {
  createMailStamp,
  hashMailBody,
  normalizeMailbox,
  normalizeToList,
  stampDate,
} = await import('../src/lib/mail-stamp.ts');
const { formatMailPayload, mailEventInputFromDetail } = await import('../src/lib/webhook-delivery.ts');
import type { WebhookSubscription } from '../src/lib/webhook-store.ts';

const ALLOWED = new Set([null, 'no', 'auto-generated', 'auto-replied', 'other']);

describe('#363-B classifyAutoSubmitted', () => {
  const rows: Array<
    [string, Parameters<typeof classifyAutoSubmitted>[0], ReturnType<typeof classifyAutoSubmitted>]
  > = [
    ['absent', undefined, null],
    ['empty', [], null],
    ['no', [{ key: 'Auto-Submitted', line: 'Auto-Submitted: no' }], 'no'],
    ['no case', [{ key: 'auto-submitted', line: 'Auto-Submitted: NO' }], 'no'],
    ['generated', [{ key: 'auto-submitted', line: 'Auto-Submitted: auto-generated' }], 'auto-generated'],
    ['replied', [{ key: 'auto-submitted', line: 'Auto-Submitted: AUTO-REPLIED' }], 'auto-replied'],
    ['extension', [{ key: 'auto-submitted', line: 'Auto-Submitted: auto-replied; owner=SECRETVALUE' }], 'other'],
    ['malformed', [{ key: 'auto-submitted', line: 'Auto-Submitted: !!!' }], 'other'],
    ['unknown', [{ key: 'auto-submitted', line: 'Auto-Submitted: auto-notified' }], 'other'],
    ['blank', [{ key: 'auto-submitted', line: 'Auto-Submitted:' }], 'other'],
    [
      'conflict',
      [
        { key: 'auto-submitted', line: 'Auto-Submitted: no' },
        { key: 'auto-submitted', line: 'Auto-Submitted: auto-replied' },
      ],
      'other',
    ],
    [
      'duplicate no',
      [
        { key: 'auto-submitted', line: 'Auto-Submitted: no' },
        { key: 'auto-submitted', line: 'Auto-Submitted: No' },
      ],
      'no',
    ],
  ];

  for (const [name, lines, want] of rows) {
    test(name, () => {
      const got = classifyAutoSubmitted(lines);
      expect(got).toBe(want);
      expect(ALLOWED.has(got)).toBe(true);
      expect(JSON.stringify(got)).not.toContain('SECRETVALUE');
    });
  }

  test('mailparser 折叠扩展头与重复 no 冲突为 other，且不回传原文', async () => {
    const parsed = await simpleParser(
      'From: a@b.test\r\nTo: c@d.test\r\nSubject: s\r\n' +
        'Auto-Submitted: auto-replied;\r\n\towner=SECRETVALUE\r\n' +
        'Auto-Submitted: no\r\n\r\nbody\r\n',
    );
    const got = classifyAutoSubmitted(parsed.headerLines);
    expect(got).toBe('other');
    expect(JSON.stringify(got)).not.toContain('SECRETVALUE');
  });
});

describe('#363-B1 toDetail', () => {
  function mime(opts: {
    from: string;
    to: string;
    subject: string;
    date: Date;
    body?: string;
    stamp?: string;
    autos?: string[];
  }): string {
    const dateHdr = opts.date.toUTCString().replace('GMT', '+0000');
    const stampLine = opts.stamp ? `X-OA-Mail-Stamp: ${opts.stamp}\r\n` : '';
    const autos = (opts.autos ?? []).map((value) => `Auto-Submitted: ${value}\r\n`).join('');
    return (
      `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.subject}\r\n` +
      `Date: ${dateHdr}\r\n${stampLine}${autos}\r\n${opts.body ?? 'hello'}`
    );
  }

  function stampFor(date: Date, from: string, to: string, subject: string, body: string): string {
    return createMailStamp(
      {
        from: normalizeMailbox(from),
        to: normalizeToList([to]),
        subject,
        dateIso: date.toISOString(),
        bodyHash: hashMailBody(body),
      },
      config.taskSigningSecret,
    );
  }

  test('source:internal 不能代替缺省的 autoSubmitted', async () => {
    const date = stampDate(new Date('2026-10-01T00:00:00Z'));
    const from = 'alice@test.example';
    const to = 'victim@test.example';
    const subject = 'ping';
    const body = 'hello';
    const parsed = await simpleParser(
      mime({ from, to, subject, date, body, stamp: stampFor(date, from, to, subject, body) }),
    );
    const detail = toDetail(1, parsed);
    expect(detail.source).toBe('internal');
    expect(detail.autoSubmitted).toBe(null);
  });

  test('internal 来源戳与 auto-replied 同时存在时各算各的', async () => {
    const date = stampDate(new Date('2026-10-01T01:00:00Z'));
    const from = 'alice@test.example';
    const to = 'victim@test.example';
    const subject = 'bot';
    const body = 'hello';
    const parsed = await simpleParser(
      mime({
        from,
        to,
        subject,
        date,
        body,
        stamp: stampFor(date, from, to, subject, body),
        autos: ['auto-replied'],
      }),
    );
    const detail = toDetail(2, parsed);
    expect(detail.source).toBe('internal');
    expect(detail.autoSubmitted).toBe('auto-replied');
  });

  test('回放 metadata/preview 与详情分类一致，原文不进载荷', async () => {
    // 重投与启动重建都走 mailEventInputFromDetail。source 不能改写本字段。
    const cases: Array<{
      autos: string[];
      want: null | 'no' | 'auto-generated' | 'auto-replied' | 'other';
      stamp: boolean;
    }> = [
      { autos: [], want: null, stamp: true },
      { autos: ['no'], want: 'no', stamp: false },
      { autos: ['auto-generated'], want: 'auto-generated', stamp: false },
      { autos: ['AUTO-REPLIED'], want: 'auto-replied', stamp: true },
      { autos: ['auto-notified'], want: 'other', stamp: false },
      { autos: ['auto-replied; owner=SECRETVALUE', 'no'], want: 'other', stamp: false },
    ];
    const envelope = {
      id: 'evt_363b2',
      type: 'mail.received' as const,
      payloadVersion: 'v1' as const,
      createdAt: '2026-10-01T02:00:00.000Z',
      domain: 'test.example',
    };
    let uid = 20;
    for (const row of cases) {
      uid += 1;
      const date = stampDate(new Date('2026-10-01T02:00:00Z'));
      const from = 'alice@test.example';
      const to = 'victim@test.example';
      const subject = 'loop';
      const body = 'hello';
      const parsed = await simpleParser(
        mime({
          from: row.stamp ? from : 'bot@example.net',
          to,
          subject,
          date,
          body,
          stamp: row.stamp ? stampFor(date, from, to, subject, body) : undefined,
          autos: row.autos,
        }),
      );
      const detail = toDetail(uid, parsed);
      if (row.stamp) expect(detail.source).toBe('internal');
      expect(detail.autoSubmitted).toBe(row.want);
      const input = mailEventInputFromDetail(detail, {
        address: to,
        messageId: detail.id,
        uidValidity: 17,
        sizeBytes: 40,
        hasAttachments: false,
        unread: true,
      });
      expect(input.autoSubmitted).toBe(row.want);
      const meta = JSON.parse(
        formatMailPayload(
          { contentScope: 'metadata', id: 'whk_m' } as WebhookSubscription,
          envelope,
          input,
        ).body,
      );
      expect(meta.payloadVersion).toBe('v1');
      expect(meta.data.autoSubmitted).toBe(row.want);
      expect(meta.data.textPreview).toBeUndefined();
      expect(meta.data.headers).toBeUndefined();
      expect(JSON.stringify(meta)).not.toContain('SECRETVALUE');
      const preview = JSON.parse(
        formatMailPayload(
          { contentScope: 'preview', id: 'whk_p' } as WebhookSubscription,
          envelope,
          input,
        ).body,
      );
      expect(preview.data.autoSubmitted).toBe(row.want);
      expect(preview.data.textPreview).toBe('hello');
      expect(JSON.stringify(preview)).not.toContain('SECRETVALUE');
    }
  });

});
