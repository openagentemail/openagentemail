import bundled from '../recommendations.json' with { type: 'json' };

export type Recommendation = {
  name: string;
  price: string;
  url: string;
  ad: boolean;
  alipay: boolean;
  note: string;
};

export type VpsRecommendation = Recommendation & {
  groups: string[];
};

export type RecommendationData = {
  version: number;
  updated: string;
  disclosure: string;
  vps: VpsRecommendation[];
  registrars: Recommendation[];
};

function isRecommendation(value: unknown): value is Recommendation;
function isRecommendation(value: unknown, groupsRequired: true): value is VpsRecommendation;
function isRecommendation(value: unknown, groupsRequired = false): value is Recommendation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const commonFieldsValid = (
    typeof item.name === 'string' &&
    typeof item.price === 'string' &&
    typeof item.url === 'string' &&
    typeof item.ad === 'boolean' &&
    typeof item.alipay === 'boolean' &&
    typeof item.note === 'string'
  );
  if (!commonFieldsValid || !groupsRequired) return commonFieldsValid;
  return (
    Array.isArray(item.groups) &&
    item.groups.length > 0 &&
    item.groups.every((group) => typeof group === 'string' && group.length > 0)
  );
}

export function isRecommendationData(value: unknown): value is RecommendationData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Number.isInteger(data.version) &&
    (data.version as number) >= 1 &&
    typeof data.updated === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(data.updated) &&
    typeof data.disclosure === 'string' &&
    Array.isArray(data.vps) &&
    data.vps.length > 0 &&
    data.vps.every((item) => isRecommendation(item, true)) &&
    Array.isArray(data.registrars) &&
    data.registrars.length > 0 &&
    data.registrars.every((item) => isRecommendation(item))
  );
}

export const BUNDLED_RECOMMENDATIONS: RecommendationData = (() => {
  if (!isRecommendationData(bundled)) {
    throw new Error('Bundled recommendations.json is invalid');
  }
  return bundled;
})();

export async function loadRecommendations(
  noFetch: boolean,
  fetcher: typeof fetch = fetch,
): Promise<RecommendationData> {
  if (noFetch) return BUNDLED_RECOMMENDATIONS;
  try {
    const response = await fetcher('https://openagent.email/recommendations.json', {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return BUNDLED_RECOMMENDATIONS;
    const remote: unknown = await response.json();
    if (
      isRecommendationData(remote) &&
      remote.version > BUNDLED_RECOMMENDATIONS.version
    ) {
      return remote;
    }
  } catch {
    return BUNDLED_RECOMMENDATIONS;
  }
  return BUNDLED_RECOMMENDATIONS;
}

export function recommendedVps(
  data: RecommendationData,
  needsAlipay: boolean,
): VpsRecommendation[] {
  const group = needsAlipay ? 'alipay' : 'global';
  const matches = data.vps.filter((item) => item.groups.includes(group));
  return needsAlipay ? matches.slice(0, 3) : matches;
}

export function recommendationLine(item: Recommendation): string {
  return `${item.name} — ${item.price} — ${item.note} — ${item.url}${item.ad ? ' (ad)' : ''}`;
}
