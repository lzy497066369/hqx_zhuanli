import type { DrawingPlanInput } from '../../src/features/utility/aiDrawing.ts';
import { aiProviders } from '../../server/aiSupport.ts';
import type { AiConfig } from '../../server/aiSupport.ts';
import { researchPatents } from '../../server/patentResearch.ts';
import type { ResponsesResearchStageObserver } from '../../server/patentResearch.ts';
import { createStrictTransport } from './strictE2eTransport.mjs';

export const strictResearchPolicy = Object.freeze({
  maxProviderRequests: 1, allowFallback: false, allowRotation: false, maxAttempts: 1,
});

export function strictResearchConfig(config: AiConfig): AiConfig {
  if (config.researchProtocol !== 'responses') throw new Error('STRICT_RESEARCH_REQUIRES_RESPONSES');
  const pinned = { ...config, fallbackModel: undefined, fallbackBaseUrl: undefined, fallbackApiKey: undefined,
    secondFallbackModel: undefined, secondFallbackBaseUrl: undefined, secondFallbackApiKey: undefined };
  if (aiProviders(pinned, pinned.researchModel || pinned.model).length !== 1) throw new Error('STRICT_RESEARCH_PROVIDER_REQUIRED');
  return Object.freeze(pinned);
}

type ResearchAttempt = Parameters<NonNullable<Parameters<typeof researchPatents>[4]>>[0];
export function createStrictResearchInvocation({ config, fetcher, onAttempt, onStage, record, allowPatentPages = false }: {
  config: AiConfig;
  /** Phase 18 opt-in only; historical research-only behavior remains unchanged. */
  allowPatentPages?: boolean;
  fetcher: typeof fetch;
  onAttempt?: (attempt: ResearchAttempt) => void;
  onStage?: ResponsesResearchStageObserver;
  record?: (entry: Record<string, unknown>) => void;
}) {
  if (typeof fetcher !== 'function') throw new Error('EXPLICIT_RESEARCH_FETCHER_REQUIRED');
  const pinned = strictResearchConfig(config);
  const transport = createStrictTransport({ baseUrl: pinned.baseUrl, model: pinned.model,
    researchModel: pinned.researchModel || pinned.model, fetcher, record,
    researchProtocol: 'responses', researchOnly: true, allowPatentPages });
  // Invocation reuse is forbidden independently of whether dispatch began.
  let invoked = false;
  return { policy: strictResearchPolicy, state: transport.state,
    async run(input: DrawingPlanInput, signal: AbortSignal) {
      if (invoked) throw new Error('STRICT_RESEARCH_INVOCATION_REUSED');
      invoked = true;
      try {
        return await researchPatents(input, pinned, signal, transport.fetch, onAttempt, false, onStage);
      } finally {
        transport.halt('RESEARCH_INVOCATION_FINISHED');
      }
    } };
}
