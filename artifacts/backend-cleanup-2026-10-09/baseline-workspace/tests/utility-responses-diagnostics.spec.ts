import { expect, test } from '@playwright/test';
import type { AiConfig } from '../server/aiSupport.ts';
import { aiProviders } from '../server/aiSupport.ts';
import { parseOfflineResearch as parseResearch } from './fixtures/verifiedPatentPage';
import { summarizeAnthropicToolResult, summarizeResponsesResearchToolResult } from '../server/researchProvider.ts';
import { responsesDiagnosticsFixture, syntheticSecrets } from './fixtures/responsesDiagnostics.ts';
import { createStrictTransport } from './support/strictE2eTransport.mjs';
import { createStrictResearchInvocation, strictResearchConfig, strictResearchPolicy } from './support/strictResearchPolicy.ts';

const config: AiConfig = { baseUrl: 'https://provider.invalid/v1', apiKey: 'OFFLINE_KEY', model: 'gpt-6-astra',
  researchModel: 'gpt-6-astra', researchProtocol: 'responses', fallbackModel: 'gpt-6-sol', secondFallbackModel: 'gpt-5.6-sol',
  fallbackBaseUrl: 'https://fallback.invalid/v1', fallbackApiKey: 'OFFLINE_FALLBACK_KEY',
  secondFallbackBaseUrl: 'https://second.invalid/v1', secondFallbackApiKey: 'OFFLINE_SECOND_KEY' };
const input = { title: '光伏组件安装支架', technicalField: '机械安装结构', structure: '', workingPrinciple: '' };
const searchPayload = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  object: 'response', status: 'completed', output: [{ type: 'web_search_call', id: syntheticSecrets.id,
    status: 'completed', action, ...extra }],
});
function noSecrets(diagnostics: unknown, extras: string[] = []) {
  const serialized = JSON.stringify(diagnostics);
  for (const value of [...Object.values(syntheticSecrets), 'Authorization', 'Bearer', 'Cookie', ...extras]) expect(serialized).not.toContain(value);
}
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('legal offline Responses fixture uses verified original page through the parser and structural diagnostics', async () => {
  const fixture = responsesDiagnosticsFixture();
  expect((await parseResearch(fixture, input)).sources).toHaveLength(1);
  const result = summarizeResponsesResearchToolResult(fixture);
  expect(result).toMatchObject({ responseType: 'response', responseStatus: 'completed', outputIsArray: true,
    outputItemCount: 3, outputItemTypes: ['web_search_call', 'web_search_call', 'message'], webSearchCallCount: 2,
    webSearchCallTypes: ['web_search_call', 'web_search_call'], webSearchCallIdsPresent: [true, true],
    webSearchCallIdLengths: [syntheticSecrets.id.length, syntheticSecrets.id.length + 5], errorPresent: false });
  expect(result.webSearchCalls[0]).toMatchObject({ actionType: 'search', sourceCount: 2, sourceTypes: ['url', 'url'] });
  expect(result.webSearchCalls[1].openedLocation).toEqual({ hostname: 'patents.google.com', pathname: '/patent/CN217307583U/zh' });
  noSecrets(result);
});

test('missing web search is observed but not upgraded into parser acceptance', async () => {
  const payload = { status: 'completed', output: [{ type: 'message', content: [] }] };
  expect(summarizeResponsesResearchToolResult(payload).webSearchCallCount).toBe(0);
  await expect(parseResearch(payload, input)).rejects.toThrow(expect.objectContaining({ code: 'RESEARCH_UNVERIFIED' }));
});

test('source URLs and open_page expose only hostname and pathname', async () => {
  const secret = syntheticSecrets;
  const url = `https://${secret.username}:${secret.password}@patents.google.com/patent/CN217307583U/en?api_key=${secret.apiKey}&token=${secret.token}#${secret.fragment}`;
  for (const action of [{ type: 'search', sources: [{ type: 'url', url }, { type: 'url', url: 'not a URL' }] }, { type: 'open_page', url }]) {
    const result = summarizeResponsesResearchToolResult(searchPayload(action));
    const call = result.webSearchCalls[0];
    const location = action.type === 'search' ? call.sources[0] : call.openedLocation;
    expect(location).toEqual({ hostname: 'patents.google.com', pathname: '/patent/CN217307583U/en' });
    noSecrets(result, [url, 'api_key=', 'token=', '#']);
  }
});

test('sensitive singular and plural queries expose presence and lengths only', async () => {
  const result = summarizeResponsesResearchToolResult(searchPayload({ type: 'search', query: syntheticSecrets.query,
    queries: [syntheticSecrets.query, '', null, 23], sources: [] }));
  expect(result.webSearchCalls[0]).toMatchObject({ actionQueryPresent: true, queryPresent: true,
    queryLength: syntheticSecrets.query.length, queriesIsArray: true, queryLengths: [syntheticSecrets.query.length, 0] });
  noSecrets(result);
  expect(summarizeResponsesResearchToolResult(searchPayload({ type: 'search', queries: [syntheticSecrets.query] })).webSearchCalls[0])
    .toMatchObject({ actionQueryPresent: true, queryPresent: false, queryLength: 0 });
});

for (const location of ['root', 'call', 'output']) {
  test(`safe ${location} error retains code but not message`, async () => {
    const error = { type: 'server_error', code: 'unavailable', message: `${syntheticSecrets.message} Authorization Bearer Cookie` };
    const payload = location === 'root' ? { object: 'response', error } : location === 'call'
      ? searchPayload({ type: 'search' }, { error }) : { output: [{ ...error, type: 'error' }] };
    const result = summarizeResponsesResearchToolResult(payload);
    expect(result).toMatchObject({ errorPresent: true, errorCode: 'unavailable', errorType: location === 'output' ? 'error' : 'server_error' });
    noSecrets(result);
  });
}

test('unknown error and provider-controlled type/status strings are redacted', async () => {
  const payload = { object: syntheticSecrets.apiKey, status: syntheticSecrets.token,
    error: { type: syntheticSecrets.password, code: syntheticSecrets.token, message: syntheticSecrets.message },
    output: [{ type: syntheticSecrets.password }, { type: 'web_search_call', id: syntheticSecrets.id,
      status: syntheticSecrets.password, action: { type: syntheticSecrets.token, query: syntheticSecrets.query,
        sources: [{ type: syntheticSecrets.apiKey, url: 'file:///PRIVATE_PATH' }] } }] };
  const result = summarizeResponsesResearchToolResult(payload);
  expect(result).toMatchObject({ responseType: '[unknown]', responseStatus: '[unknown]', errorType: '[unknown]', errorCode: '[unknown]',
    outputItemTypes: ['[unknown]', 'web_search_call'] });
  expect(result.webSearchCalls[0]).toMatchObject({ callStatus: '[unknown]', actionType: '[unknown]', sourceTypes: ['[unknown]'], sources: [] });
  noSecrets(result, ['PRIVATE_PATH']);
});

for (const [name, payload] of Object.entries({ null: null, string: syntheticSecrets.message, missing: {},
  nonArray: { output: syntheticSecrets.message }, malformed: { output: [null, [], 2, { type: 'web_search_call', action: null }] } })) {
  test(`malformed ${name} payload is safe to summarize without changing rejection`, async () => {
    const result = summarizeResponsesResearchToolResult(payload);
    expect(result.outputIsArray).toBe(name === 'malformed');
    noSecrets(result);
    await expect(parseResearch(payload, input)).rejects.toThrow(expect.objectContaining({ code: 'RESEARCH_UNVERIFIED' }));
  });
}

test('existing Anthropic summary remains separate and retains unavailable rejection classification', async () => {
  const result = summarizeAnthropicToolResult({ type: 'web_search_tool_result', tool_use_id: syntheticSecrets.id,
    content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] }, new Set([syntheticSecrets.id]));
  expect(result).toMatchObject({ toolUseIdMatched: true, toolResultErrorCodes: ['unavailable'], toolResultFailureReason: 'TOOL_RESULT_ERROR' });
  noSecrets(result);
});

test('production fallback providers are unchanged; strict config is a nonmutating primary-only copy', async () => {
  const before = structuredClone(config);
  expect(aiProviders(config, config.researchModel).map(provider => provider.model)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']);
  const pinned = strictResearchConfig(config);
  expect(aiProviders(pinned, pinned.researchModel).map(provider => provider.model)).toEqual(['gpt-6-astra']);
  expect(config).toEqual(before);
  expect(pinned.fallbackApiKey).toBeUndefined();
  expect(pinned.secondFallbackApiKey).toBeUndefined();
  expect(Object.isFrozen(pinned)).toBe(true);
  expect(strictResearchPolicy).toEqual({ maxProviderRequests: 1, allowFallback: false, allowRotation: false, maxAttempts: 1 });
  expect(Object.isFrozen(strictResearchPolicy)).toBe(true);
});

test('strict invocation starts at zero and delegates one unchanged Responses request, then stops', async () => {
  const attempts: unknown[] = [], events: Record<string, unknown>[] = [];
  let delegates = 0;
  const invocation = createStrictResearchInvocation({ config, onAttempt: attempt => attempts.push(attempt), record: entry => events.push(entry),
    fetcher: async (url, init) => {
      delegates++;
      expect(String(url)).toBe('https://provider.invalid/v1/responses');
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'gpt-6-astra', stream: false, tool_choice: 'required',
        tools: [{ type: 'web_search', filters: { allowed_domains: ['patents.google.com'] } }], include: ['web_search_call.action.sources'] });
      return jsonResponse(responsesDiagnosticsFixture());
    } });
  expect(invocation.state).toMatchObject({ researchRequests: 0, generationRequests: 0, pageFetches: 0 });
  // Historical strict policy forbids original-page fetches; it must no longer report Research success.
  await expect(invocation.run(input, new AbortController().signal)).rejects.toMatchObject({ code: 'EVIDENCE_FETCH_FAILED' });
  expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 0, halted: true });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ outcome: 'EVIDENCE_FETCH_FAILED', protocol: 'responses', responsesToolResultDiagnostics: { webSearchCallCount: 2 } });
  noSecrets(attempts);
  noSecrets(events, ['OFFLINE_KEY', 'OFFLINE_FALLBACK_KEY', 'OFFLINE_SECOND_KEY']);
  await expect(invocation.run(input, new AbortController().signal)).rejects.toThrow('STRICT_RESEARCH_INVOCATION_REUSED');
  expect(delegates).toBe(1);
});

for (const kind of ['http', 'network', 'parser', 'json', 'empty', 'rate-limit', 'abort-after-dispatch', 'non-json-http']) {
  test(`strict ${kind} failure stops after one mock dispatch with no fallback or retry`, async () => {
    let delegates = 0;
    const controller = new AbortController(), attempts: unknown[] = [];
    const invocation = createStrictResearchInvocation({ config, onAttempt: attempt => attempts.push(attempt), fetcher: async () => {
      delegates++;
      if (kind === 'network') throw new Error(syntheticSecrets.message);
      if (kind === 'http' || kind === 'rate-limit') return jsonResponse({ error: { type: 'server_error', code: 'unavailable', message: syntheticSecrets.message } }, kind === 'http' ? 503 : 429);
      if (kind === 'non-json-http') return new Response(syntheticSecrets.message, { status: 502 });
      if (kind === 'json') return new Response('not-json');
      if (kind === 'empty') return new Response(null);
      if (kind === 'abort-after-dispatch') { controller.abort(new Error('ABORT_FIXTURE')); return jsonResponse(responsesDiagnosticsFixture()); }
      return jsonResponse(searchPayload({ type: 'search', query: syntheticSecrets.query, sources: [] }));
    } });
    await expect(invocation.run(input, controller.signal)).rejects.toThrow();
    expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 0, halted: true });
    expect(attempts).toHaveLength(1);
    if (kind === 'parser') expect(attempts[0]).toMatchObject({ outcome: 'RESEARCH_UNVERIFIED', responsesToolResultDiagnostics: { webSearchCallCount: 1 } });
    if (kind === 'http' || kind === 'rate-limit') expect(attempts[0]).toMatchObject({ responsesToolResultDiagnostics: { errorPresent: true, errorCode: 'unavailable' } });
    noSecrets(attempts);
    await expect(invocation.run(input, controller.signal)).rejects.toThrow('STRICT_RESEARCH_INVOCATION_REUSED');
    expect(delegates).toBe(1);
  });
}

test('pre-aborted invocation delegates zero and cannot be reused', async () => {
  let delegates = 0;
  const invocation = createStrictResearchInvocation({ config, fetcher: async () => { delegates++; return jsonResponse({}); } });
  const controller = new AbortController(); controller.abort(new Error('ABORT_FIXTURE'));
  await expect(invocation.run(input, controller.signal)).rejects.toThrow('ABORT_FIXTURE');
  expect(invocation.state).toMatchObject({ researchRequests: 0, generationRequests: 0, pageFetches: 0, halted: true, providerRequestFailed: false });
  await expect(invocation.run(input, new AbortController().signal)).rejects.toThrow('STRICT_RESEARCH_INVOCATION_REUSED');
  expect(delegates).toBe(0);
});

function transportForTest(fetcher: typeof fetch) {
  return createStrictTransport({ baseUrl: config.baseUrl, model: config.model, researchModel: config.researchModel || config.model,
    researchProtocol: 'responses', researchOnly: true, fetcher });
}
const requestOptions = (model = 'gpt-6-astra') => ({ method: 'POST', redirect: 'error' as const,
  body: JSON.stringify({ model, tools: [{ type: 'web_search' }] }) });

test('strict shared counter blocks a hidden second dispatch without delegating', async () => {
  let delegates = 0;
  const transport = transportForTest(async () => { delegates++; return jsonResponse({}); });
  await transport.fetch('https://provider.invalid/v1/responses', requestOptions());
  await expect(transport.fetch('https://provider.invalid/v1/responses', requestOptions())).rejects.toThrow('RESEARCH_REQUEST_NOT_SINGLE_NATIVE_SEARCH');
  expect(transport.state.researchRequests).toBe(1);
  expect(delegates).toBe(1);
});

for (const kind of ['rotation-host', 'rotation-model', 'generation', 'page', 'wrong-protocol', 'redirect', 'extra-endpoint']) {
  test(`strict boundary blocks ${kind} before delegate`, async () => {
    let delegates = 0;
    const transport = transportForTest(async () => { delegates++; return jsonResponse({}); });
    const url = kind === 'rotation-host' ? 'https://fallback.invalid/v1/responses' : kind === 'generation'
      ? 'https://provider.invalid/v1/chat/completions' : kind === 'page' ? 'https://patents.google.com/patent/CN217307583U/en'
      : kind === 'wrong-protocol' ? 'https://provider.invalid/v1/messages' : kind === 'extra-endpoint'
        ? 'https://provider.invalid/v1/responses?retry=1' : 'https://provider.invalid/v1/responses';
    const options = kind === 'page' ? { method: 'GET', redirect: 'error' as const } : {
      ...requestOptions(kind === 'rotation-model' ? 'gpt-6-sol' : undefined), ...(kind === 'redirect' ? { redirect: 'follow' as const } : {}),
    };
    await expect(transport.fetch(url, options)).rejects.toThrow();
    expect(transport.state).toMatchObject({ researchRequests: 0, generationRequests: 0, pageFetches: 0 });
    expect(delegates).toBe(0);
  });
}

test('legacy strict transport defaults still delegate Anthropic responses unchanged', async () => {
  const response = jsonResponse({ content: [] });
  const transport = createStrictTransport({ baseUrl: config.baseUrl, model: config.model, researchModel: 'claude-opus-5-5', fetcher: async () => response });
  expect(await transport.fetch('https://provider.invalid/v1/messages', { method: 'POST', redirect: 'error',
    body: JSON.stringify({ model: 'claude-opus-5-5', tools: [{ type: 'web_search_20250305' }] }) })).toBe(response);
  expect(transport.state).toMatchObject({ researchRequests: 1, generationRequests: 0, halted: false });
});

test('strict helper rejects wrong protocol or absent selected provider before invocation', async () => {
  expect(() => strictResearchConfig({ ...config, researchProtocol: 'anthropic' })).toThrow('STRICT_RESEARCH_REQUIRES_RESPONSES');
  expect(() => strictResearchConfig({ ...config, apiKey: '' })).toThrow('STRICT_RESEARCH_PROVIDER_REQUIRED');
});
