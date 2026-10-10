import { responsesStageFixture, stageFixtureSecrets, stageSearchCall } from './responsesStageBoundary.ts';

export type CoverageFixtureName = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const coverageFixtureCounts = {
  A: { queries: 1, results: 2, qualified: 2 },
  B: { queries: 2, results: 4, qualified: 4 },
  C: { queries: 2, results: 10, qualified: 10 },
  D: { queries: 3, results: 0, qualified: 0 },
  E: { queries: 2, results: 4, qualified: 1 },
  F: { queries: 2, results: 2, qualified: 1 },
} as const;

// B/C/E/F represent unattributed result pools, not fabricated per-query ownership schemas.
export function responsesCoverageFixture(name: CoverageFixtureName) {
  const counts = coverageFixtureCounts[name];
  const payload = responsesStageFixture();
  const queries = Array.from({ length: counts.queries }, (_, index) => `${stageFixtureSecrets.query}_${index}`);
  const sources = Array.from({ length: counts.results }, (_, index) => ({
    type: 'url',
    url: name === 'F' && index === 1 ? 'https://example.com/unrelated'
      : `https://patents.google.com/patent/CN${220000001 + (name === 'E' ? 0 : index)}U/${index % 2 ? 'en' : 'zh'}`,
  }));
  payload.output[0] = stageSearchCall({ type: 'search', query: queries[0], queries, sources });
  return payload;
}
