// Test-only boundary. Real runs delegate unchanged responses to native fetch.
/**
 * @param {{ baseUrl: string, model: string, researchModel: string, fetcher: typeof globalThis.fetch,
 *   record?: (entry: Record<string, unknown>) => void,
 *   researchProtocol?: 'anthropic' | 'responses', researchOnly?: boolean, allowPatentPages?: boolean }} options
 */
export function createStrictTransport({ baseUrl, model, researchModel, fetcher, record = () => {}, researchProtocol = 'anthropic', researchOnly = false, allowPatentPages = false }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('UNSAFE_PROVIDER');
  if (![model, researchModel].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/u.test(value))) throw new Error('UNSAFE_MODEL_IDENTIFIER');
  if (!['anthropic', 'responses'].includes(researchProtocol) || typeof researchOnly !== 'boolean' || typeof allowPatentPages !== 'boolean') throw new Error('INVALID_RESEARCH_POLICY');
  const endpoint = base.href.replace(/\/+$/, '');
  const state = { researchRequests: 0, generationRequests: 0, pageFetches: 0, pending: false,
    halted: false, providerRequestFailed: false, abortReason: null, violations: 0 };
  const completedIds = new Set();
  const halt = (reason = 'TEST_ABORT') => {
    state.halted = true;
    state.abortReason ||= reason;
  };
  const providerFailure = (kind, httpStatus, outcome) => {
    state.providerRequestFailed = true;
    halt('PROVIDER_REQUEST_FAILURE');
    record({ type: 'provider-failure', kind, httpStatus, outcome, requestStarted: true });
  };
  const block = code => {
    halt('SAFETY_VIOLATION');
    state.violations += 1;
    record({ type: 'safety-block', code });
    throw new Error(code);
  };
  const diagnostic = entry => {
    if (!entry?.strictGeneration) return;
    if (!state.pending && entry.attemptCount === 0 && entry.providerRequestCount === 0 && entry.outcome === 'aborted') {
      halt('TEST_ABORT');
      record({ type: 'test-abort', code: 'ABORT_BEFORE_DISPATCH', requestStarted: false });
      return;
    }
    if (!state.pending || entry.attemptCount !== 1 || entry.providerRequestCount !== 1 ||
        entry.providerHost !== base.hostname || entry.model !== model || entry.fallbackUsed !== false ||
        entry.rotationUsed !== false || !/^[0-9a-f-]{36}$/u.test(entry.invocationId || '') || completedIds.has(entry.invocationId) ||
        !/^(completed|aborted|network_error|AI_[A-Z_]+)$/u.test(entry.outcome || '')) {
      block('INVOCATION_DIAGNOSTIC_INVALID');
    }
    completedIds.add(entry.invocationId);
    state.pending = false;
    if (entry.outcome !== 'completed') providerFailure('generation', entry.httpStatus, entry.outcome);
    record({ type: 'generation-invocation', invocationId: entry.invocationId, attemptCount: 1,
      providerRequestCount: 1, providerHost: base.hostname, model, httpStatus: entry.httpStatus,
      outcome: entry.outcome, fallbackUsed: false, rotationUsed: false });
  };
  const fetch = async (input, init = {}) => {
    if (state.halted) block(state.providerRequestFailed ? 'REQUEST_AFTER_FAILURE' : 'REQUEST_AFTER_ABORT');
    const url = new URL(String(input));
    if (init.signal?.aborted) throw init.signal.reason;
    let kind;
    const researchEndpoint = `${endpoint}/${researchProtocol === 'responses' ? 'responses' : 'messages'}`;
    if (url.href === researchEndpoint || url.href === `${endpoint}/chat/completions`) {
      if (init.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string') block('INVALID_REQUEST_OPTIONS');
      let body;
      try { body = JSON.parse(init.body); } catch { block('INVALID_REQUEST_BODY'); }
      if (url.href === researchEndpoint) {
        const toolType = researchProtocol === 'responses' ? 'web_search' : 'web_search_20250305';
        if (state.researchRequests !== 0 || state.generationRequests !== 0 || body.model !== researchModel ||
            !Array.isArray(body.tools) || !body.tools.some(tool => tool?.type === toolType)) block('RESEARCH_REQUEST_NOT_SINGLE_NATIVE_SEARCH');
        state.researchRequests += 1;
        kind = 'research';
      } else {
        if (researchOnly) block('RESEARCH_ONLY_GENERATION_FORBIDDEN');
        if (state.researchRequests !== 1 || state.pending || body.model !== model) block('GENERATION_RETRY_OR_ROTATION');
        state.pending = true;
        state.generationRequests += 1;
        kind = 'generation';
      }
    } else if ((!researchOnly || allowPatentPages) && url.protocol === 'https:' && url.hostname === 'patents.google.com' && !url.username && !url.password &&
        !url.port && !url.search && !url.hash && /^\/patent\/[A-Z]{2}[0-9]+[A-Z][0-9]?\/en$/iu.test(url.pathname) &&
        (!init.method || init.method === 'GET') && init.redirect === 'error' && state.researchRequests === 1 && state.generationRequests === 0) {
      state.pageFetches += 1;
      kind = 'patent-page';
    } else block('UNEXPECTED_OUTBOUND_REQUEST');
    record({ type: 'request', kind, providerHost: url.hostname,
      ...(kind === 'patent-page' ? {} : { model: kind === 'research' ? researchModel : model }),
      researchRequests: state.researchRequests, generationRequests: state.generationRequests });
    try {
      const response = await fetcher(input, init);
      record({ type: 'response', kind, httpStatus: response.status });
      // A patent page may be unavailable; the unchanged Research gate decides its validity.
      if (!response.ok && kind !== 'patent-page') providerFailure(kind, response.status, 'HTTP_ERROR');
      return response;
    } catch (error) {
      if (kind !== 'patent-page') providerFailure(kind, null, 'NETWORK_OR_ABORT');
      record({ type: 'response', kind, httpStatus: null, outcome: 'NETWORK_OR_ABORT' });
      throw error;
    }
  };
  return { fetch, diagnostic, state, halt };
}
