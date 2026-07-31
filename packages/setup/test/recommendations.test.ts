import { describe, expect, test } from 'bun:test';
import {
  BUNDLED_RECOMMENDATIONS,
  isRecommendationData,
  loadRecommendations,
  recommendedVps,
} from '../src/recommendations.ts';

describe('recommendations.json', () => {
  test('bundled data matches the offline schema and link rules', () => {
    expect(isRecommendationData(BUNDLED_RECOMMENDATIONS)).toBe(true);
    expect(BUNDLED_RECOMMENDATIONS.version).toBe(4);
    expect(BUNDLED_RECOMMENDATIONS.vps.length).toBeGreaterThanOrEqual(6);
    expect(BUNDLED_RECOMMENDATIONS.registrars.length).toBeGreaterThanOrEqual(4);
    for (const item of [
      ...BUNDLED_RECOMMENDATIONS.vps,
      ...BUNDLED_RECOMMENDATIONS.registrars,
    ]) {
      if (item.ad) {
        // Affiliate entries carry a real owner link or await one.
        expect(
          item.url === '<PENDING_OWNER_LINK>' || item.url.startsWith('https://'),
        ).toBe(true);
      } else {
        // Non-affiliate entries always link directly.
        expect(item.url.startsWith('https://')).toBe(true);
      }
    }
    const cloudflare = BUNDLED_RECOMMENDATIONS.registrars.find(
      (item) => item.name === 'Cloudflare Registrar',
    );
    expect(cloudflare?.ad).toBe(false);
    expect(cloudflare?.url).toBe('https://www.cloudflare.com/products/registrar/');
  });

  test('every VPS requires a non-empty string groups array', () => {
    for (const groups of [undefined, [], ['global', 1]]) {
      const invalid = structuredClone(BUNDLED_RECOMMENDATIONS) as unknown as Record<string, unknown>;
      const vps = invalid.vps as Array<Record<string, unknown>>;
      vps[0]!.groups = groups;
      expect(isRecommendationData(invalid)).toBe(false);
    }
  });

  test('a newer valid remote version wins and failures fall back silently', async () => {
    const remote = {
      ...BUNDLED_RECOMMENDATIONS,
      version: BUNDLED_RECOMMENDATIONS.version + 1,
    };
    const fetched = await loadRecommendations(false, async () =>
      new Response(JSON.stringify(remote), { status: 200 }));
    expect(fetched.version).toBe(remote.version);

    const fallback = await loadRecommendations(false, async () => {
      throw new Error('offline');
    });
    expect(fallback).toBe(BUNDLED_RECOMMENDATIONS);
  });

  test('payment preference selects the intended VPS groups', () => {
    expect(recommendedVps(BUNDLED_RECOMMENDATIONS, true).map((item) => item.name)).toEqual([
      'RackNerd',
      'GreenCloud',
      'Evoxt',
    ]);
    expect(recommendedVps(BUNDLED_RECOMMENDATIONS, false).map((item) => item.name)).toEqual([
      'Contabo',
      'RackNerd',
      'UpCloud',
    ]);
  });
});
