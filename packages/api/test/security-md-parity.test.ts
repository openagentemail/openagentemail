/**
 * docs/security.md 四级分层表 ↔ TOOL_TIER_SPEC 注册表 parity。
 * 防手维护表再漂（#287：表 20 / 真值 25）。
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_TIER_SPEC, type ToolTier } from '../src/lib/tool-tiers.ts';

/** 合法级别字面量（与 ToolTier 对齐）。 */
const TIERS = new Set<ToolTier>(['read', 'minimal', 'contained', 'critical']);

/**
 * 解析 security.md 四级分层表，得到 { 工具名: tier }。
 * 只认「| 级别 | 工具 | …」行；策略要点列忽略。
 */
function parseSecurityMdTierTable(md: string): Record<string, ToolTier> {
  const out: Record<string, ToolTier> = {};
  // 匹配四行：| read | tool, tool | … |
  const rowRe = /^\|\s*(read|minimal|contained|critical)\s*\|\s*([^|]+)\|/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(md)) !== null) {
    const tier = m[1] as ToolTier;
    const toolsCell = m[2]!;
    for (const raw of toolsCell.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (out[name] !== undefined) {
        throw new Error(`security.md 表内重复工具: ${name}`);
      }
      out[name] = tier;
    }
  }
  return out;
}

describe('security.md ↔ TOOL_TIER_SPEC parity', () => {
  test('分层表工具集合与 tier 与注册表双向一致且总数=25', async () => {
    const md = await Bun.file(new URL('../../../docs/security.md', import.meta.url)).text();
    const fromDoc = parseSecurityMdTierTable(md);
    const fromSpec = TOOL_TIER_SPEC as Record<string, ToolTier>;

    const docNames = new Set(Object.keys(fromDoc));
    const specNames = new Set(Object.keys(fromSpec));

    // 双向 diff：表缺 X = 注册有而表无；注册多 Y 同义换位说清该改哪一侧
    const missingInTable = [...specNames].filter((n) => !docNames.has(n)).sort();
    const extraInTable = [...docNames].filter((n) => !specNames.has(n)).sort();
    if (missingInTable.length > 0 || extraInTable.length > 0) {
      const parts: string[] = [];
      if (missingInTable.length > 0) {
        parts.push(`表缺 ${missingInTable.join(', ')}（应改 docs/security.md）`);
      }
      if (extraInTable.length > 0) {
        parts.push(`注册多/表多 ${extraInTable.join(', ')}（表多→改 docs；注册缺→改 tool-tiers.ts）`);
      }
      throw new Error(parts.join('；'));
    }

    expect(docNames.size).toBe(25);
    expect(specNames.size).toBe(25);
    expect(docNames.size).toBe(specNames.size);

    for (const name of docNames) {
      const docTier = fromDoc[name]!;
      const specTier = fromSpec[name]!;
      expect(TIERS.has(docTier)).toBe(true);
      expect(docTier).toBe(specTier);
    }
  });
});
