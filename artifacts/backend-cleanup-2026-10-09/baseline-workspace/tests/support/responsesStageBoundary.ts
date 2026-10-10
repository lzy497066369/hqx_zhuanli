import { AiFailure } from '../../server/aiSupport.ts';
import type { ResponsesResearchStage, ResponsesResearchStageDiagnostics, ResponsesResearchStageObserver } from '../../server/patentResearch.ts';

type BoundaryStage = 'search-action' | 'search-results' | 'query-coverage';
type ObservationStatus = 'NOT_RUN' | 'PASS' | 'FAIL' | 'NOT_IMPLEMENTED_FOR_RESPONSES';

export class ResponsesStageStop extends AiFailure {
  constructor(readonly stage: BoundaryStage) {
    super(409, 'TEST_RESPONSES_STAGE_STOP', `TEST_RESPONSES_STAGE_STOP:${stage}`);
  }
}

/** Test-only control flow. PASS here describes fixture observations, not a production gate. */
export function createResponsesStageBoundary() {
  const stages: Array<{ stage: ResponsesResearchStage; diagnostics: ResponsesResearchStageDiagnostics }> = [];
  const status: Record<BoundaryStage, ObservationStatus> = {
    'search-action': 'NOT_RUN', 'search-results': 'NOT_RUN', 'query-coverage': 'NOT_RUN',
  };
  const invocations = { citation: 0, source: 0, fact: 0 };
  const observer: ResponsesResearchStageObserver = (stage, diagnostics) => {
    stages.push({ stage, diagnostics });
    if (stage === 'citation' || stage === 'source' || stage === 'fact') {
      invocations[stage]++;
      throw new Error('TEST_DOWNSTREAM_STAGE_ENTERED');
    }
    if (stage === 'query-coverage') {
      status[stage] = 'NOT_IMPLEMENTED_FOR_RESPONSES';
      throw new ResponsesStageStop(stage);
    }
    const passed = stage === 'search-action' ? (diagnostics.searchActionCount ?? 0) > 0
      : (diagnostics.searchResultCount ?? 0) > 0 && (diagnostics.qualifiedPatentResultCount ?? 0) > 0;
    status[stage] = passed ? 'PASS' : 'FAIL';
    if (!passed) throw new ResponsesStageStop(stage);
  };
  return { observer, stages, status, invocations };
}
