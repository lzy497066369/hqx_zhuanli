import type { ResponsesResearchStageDiagnostics } from '../../server/patentResearch.ts';

export type QueryCoverageStatus = 'COVERED' | 'NOT_COVERED' | 'UNKNOWN';

/** Observations only: the available evidence does not establish per-query result attribution. */
export function observeUnresolvedResponsesQueryCoverage(
  diagnostics: Pick<ResponsesResearchStageDiagnostics, 'observedQueryCount'>,
) {
  const queryCount = diagnostics.observedQueryCount;
  if (queryCount !== null && (!Number.isInteger(queryCount) || queryCount < 0 || queryCount > 10)) {
    throw new Error('INVALID_OBSERVED_QUERY_COUNT');
  }
  const statuses = Array.from({ length: queryCount ?? 0 }, (_, queryIndex) => Object.freeze({
    queryIndex, status: 'UNKNOWN' as QueryCoverageStatus,
  }));
  return Object.freeze({
    measurement: 'OBSERVED_ONLY' as const,
    queryCount,
    coveredQueryCount: null,
    coverageRatio: null,
    statuses: Object.freeze(statuses),
    gate: 'NOT_EVALUABLE' as const,
    reason: 'QUERY_RESULT_ASSOCIATION_NOT_ESTABLISHED' as const,
  });
}
