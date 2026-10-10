import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { chatJson } from '../server/patentStructureAi';
import { AiFailure, STRICT_E2E_POLICY, aiProviders, markProviderFailed, markProviderSucceeded, type AiConfig } from '../server/aiSupport';
import { createStrictTransport } from './support/strictE2eTransport.mjs';
import { createStrictLogObservers, serverDiagnostic, startIsolatedServer } from './support/strictE2eDiagnostics.mjs';

test.describe.configure({ mode: 'serial', retries: 0 });
const config: AiConfig = { baseUrl: 'https://primary.example/v1', apiKey: 'local-test-only', model: 'primary',
  fallbackBaseUrl: 'https://secondary.example/v1', fallbackModel: 'secondary', fallbackApiKey: 'local-test-only' };
const strict = { ...config, executionPolicy: STRICT_E2E_POLICY };
const response = (value: unknown = { ok: true }, finish_reason = 'stop') => new Response(JSON.stringify({
  choices: [{ finish_reason, message: { content: JSON.stringify(value) } }],
}), { status: 200 });
const options = { lengthRetry: { prompt: 'local length repair', maxTokens: 100 },
  validationRetry: { prompt: () => 'local validation repair', maxTokens: 100 } };

async function capture(run: () => Promise<unknown>) {
  const entries: Record<string, unknown>[] = [];
  const original = console.info;
  console.info = value => { entries.push(JSON.parse(value)); };
  try { return { result: await run(), entries }; }
  catch (error) { return { error, entries }; }
  finally { console.info = original; }
}
test.afterEach(() => { aiProviders(config).forEach(markProviderSucceeded); });

test('strict success dispatches one primary request with actual count diagnostics', async () => {
  const calls: string[] = [];
  const result = await capture(() => chatJson('local', {}, strict, new AbortController().signal,
    async input => { calls.push(String(input)); return response(); }, 100));
  expect(result.error).toBeUndefined();
  expect(calls).toEqual(['https://primary.example/v1/chat/completions']);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({ attemptCount: 1, providerRequestCount: 1, fallbackUsed: false, rotationUsed: false, outcome: 'completed' });
});

for (const kind of ['rate-limit', 'upstream', 'length', 'json', 'validation', 'network', 'timeout'] as const) {
  test(`strict ${kind} stops at one request without retry or fallback`, async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(String(input));
      if (kind === 'rate-limit') return new Response('', { status: 429 });
      if (kind === 'upstream') return new Response('', { status: 503 });
      if (kind === 'length') return response({}, 'length');
      if (kind === 'json') return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }] }));
      if (kind === 'network') throw new AiFailure(502, 'AI_NETWORK', 'local network failure');
      if (kind === 'timeout') return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
      return response({ invalid: true });
    };
    const result = await capture(() => chatJson('local', {}, strict, new AbortController().signal,
      fetcher, 100, undefined, value => (value as { ok?: boolean }).ok === true,
      { ...options, stopOnInvalid: true, attemptTimeoutMs: 30 }));
    expect(result.error).toBeTruthy();
    expect(calls).toEqual(['https://primary.example/v1/chat/completions']);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ attemptCount: 1, providerRequestCount: 1, fallbackUsed: false, rotationUsed: false });
  });
}

test('strict pre-aborted request dispatches zero requests', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await capture(() => chatJson('local', {}, strict, controller.signal,
    async () => { calls++; return response(); }, 100));
  expect(result.error).toBeTruthy(); expect(calls).toBe(0);
  expect(result.entries[0]).toMatchObject({ attemptCount: 0, providerRequestCount: 0, outcome: 'aborted' });
});

test('strict ignores cooldown; normal mode retains provider cooldown selection', async () => {
  markProviderFailed(aiProviders(config)[0]);
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => { calls.push(String(input)); return response(); };
  await capture(() => chatJson('local', {}, strict, new AbortController().signal, fetcher, 100));
  await chatJson('local', {}, config, new AbortController().signal, fetcher, 100);
  expect(calls).toEqual(['https://primary.example/v1/chat/completions', 'https://secondary.example/v1/chat/completions']);
});

test('normal production retains retryable failure fallback', async () => {
  const calls: string[] = [];
  const result = await chatJson('local', {}, config, new AbortController().signal, async input => {
    calls.push(String(input)); return calls.length === 1 ? new Response('', { status: 429 }) : response();
  }, 100);
  expect(result.model).toBe('secondary');
  expect(calls).toEqual(['https://primary.example/v1/chat/completions', 'https://secondary.example/v1/chat/completions']);
});

for (const kind of ['length', 'validation'] as const) {
  test(`normal production retains ${kind} repair retry`, async () => {
    let count = 0;
    await chatJson('local', {}, config, new AbortController().signal, async () => {
      count++;
      return count === 1 ? response({ ok: false }, kind === 'length' ? 'length' : 'stop') : response();
    }, 100, undefined, value => (value as { ok?: boolean }).ok === true, options);
    expect(count).toBe(2);
  });
}

const requestOptions = (model: string, research = false) => ({ method: 'POST', redirect: 'error' as const,
  body: JSON.stringify({ model, ...(research ? { tools: [{ type: 'web_search_20250305' }] } : {}) }) });
const diagnostic = (outcome = 'completed') => ({ strictGeneration: true, invocationId: randomUUID(),
  attemptCount: 1, providerRequestCount: 1, providerHost: 'primary.example', model: 'primary', httpStatus: 200,
  outcome, fallbackUsed: false, rotationUsed: false });

test('transport delegates actual response unchanged; blocks hidden retry', async () => {
  let requests = 0;
  const original = response();
  const guard = createStrictTransport({ baseUrl: config.baseUrl, model: config.model, researchModel: 'research',
    fetcher: async () => { requests++; return original; } });
  expect(await guard.fetch(`${config.baseUrl}/messages`, requestOptions('research', true))).toBe(original);
  expect(await guard.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'))).toBe(original);
  await expect(guard.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'))).rejects.toThrow('GENERATION_RETRY_OR_ROTATION');
  expect(requests).toBe(2);
});

test('transport permits independent invocations, but blocks any dispatch after failure', async () => {
  let requests = 0;
  const guard = createStrictTransport({ baseUrl: config.baseUrl, model: config.model, researchModel: 'research',
    fetcher: async () => { requests++; return response(); } });
  await guard.fetch(`${config.baseUrl}/messages`, requestOptions('research', true));
  await guard.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'));
  guard.diagnostic(diagnostic());
  await guard.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'));
  guard.diagnostic(diagnostic('AI_INVALID_OUTPUT'));
  await expect(guard.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'))).rejects.toThrow('REQUEST_AFTER_FAILURE');
  expect(requests).toBe(3);
});

for (const kind of ['research-repeat', 'rotation', 'model-switch'] as const) {
  test(`transport blocks ${kind} before dispatch`, async () => {
    let requests = 0;
    const guard = createStrictTransport({ baseUrl: config.baseUrl, model: config.model, researchModel: 'research',
      fetcher: async () => { requests++; return response(); } });
    await guard.fetch(`${config.baseUrl}/messages`, requestOptions('research', true));
    const endpoint = kind === 'research-repeat' ? `${config.baseUrl}/messages` : kind === 'rotation'
      ? 'https://secondary.example/v1/chat/completions' : `${config.baseUrl}/chat/completions`;
    await expect(guard.fetch(endpoint, requestOptions(kind === 'research-repeat' ? 'research' : 'secondary', kind === 'research-repeat'))).rejects.toThrow();
    expect(requests).toBe(1);
  });
}

test('browser real retry helper obeys isolated mode and preserves default retry', async ({ page }) => {
  await page.goto('/');
  const count = await page.evaluate(async () => {
    const path = '/src/features/utility/progressRequest.ts';
    const { withAiRetry } = await import(/* @vite-ignore */ path);
    let attempts = 0;
    try { await withAiRetry(async () => { attempts++; throw Object.assign(new Error('local'), { code: 'AI_UPSTREAM' }); }, { retryDelayMs: 0 }); }
    catch { /* Local failure is intentional. */ }
    return attempts;
  });
  expect(count).toBe(process.env.PHASE10_MODE === 'strict-local' ? 1 : 2);
});

function isolation(fetcher: typeof fetch = async () => response()) {
  const entries: Record<string, unknown>[] = [];
  const record = (entry: Record<string, unknown>) => { entries.push(entry); };
  const transport = createStrictTransport({ baseUrl: config.baseUrl, model: config.model, researchModel: 'research', fetcher, record });
  return { transport, entries, record, logs: createStrictLogObservers(transport, record) };
}

test('ordinary server warning permits Research dispatch', async () => {
  const { transport, logs } = isolation();
  logs.warn('dependency warning', { message: 'local warning' });
  await transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true));
  expect(transport.state).toMatchObject({ researchRequests: 1, halted: false, providerRequestFailed: false });
});

test('generic server error is diagnosed without REQUEST_AFTER_FAILURE', async () => {
  const { transport, logs, entries } = isolation();
  logs.error(new TypeError('Bearer secret Authorization Cookie private input'));
  expect(transport.state).toMatchObject({ researchRequests: 0, halted: false, providerRequestFailed: false });
  await transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true));
  expect(entries[0]).toMatchObject({ type: 'server-error', errorType: 'TypeError', requestStarted: false,
    providerRequestFailed: false, stage: 'before-research-dispatch' });
  expect(JSON.stringify(entries)).not.toMatch(/secret|Authorization|Cookie|Bearer|private input/u);
});

test('actual started provider network failure rejects subsequent request', async () => {
  let calls = 0;
  const { transport, entries } = isolation(async () => { calls++; throw new Error('private response'); });
  await expect(transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true))).rejects.toThrow();
  await expect(transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true))).rejects.toThrow('REQUEST_AFTER_FAILURE');
  expect(calls).toBe(1);
  expect(entries).toContainEqual({ type: 'provider-failure', kind: 'research', httpStatus: null, outcome: 'NETWORK_OR_ABORT', requestStarted: true });
});

test('abort before provider dispatch cannot mark provider request failed', async () => {
  let calls = 0;
  const { transport } = isolation(async () => { calls++; return response(); });
  const controller = new AbortController(); controller.abort();
  await expect(transport.fetch(`${config.baseUrl}/messages`, { ...requestOptions('research', true), signal: controller.signal })).rejects.toThrow();
  transport.diagnostic({ strictGeneration: true, attemptCount: 0, providerRequestCount: 0, outcome: 'aborted' });
  expect(transport.state).toMatchObject({ researchRequests: 0, generationRequests: 0, providerRequestFailed: false, abortReason: 'TEST_ABORT' });
  await expect(transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true))).rejects.toThrow('REQUEST_AFTER_ABORT');
  expect(calls).toBe(0);
});

test('server startup failure stops E2E without declaring provider failure', async () => {
  const { transport, entries, record } = isolation();
  let closed = false;
  await expect(startIsolatedServer(async () => ({ listen: async () => {
    throw Object.assign(new Error('private startup detail'), { code: 'EADDRINUSE' });
  }, close: async () => { closed = true; } }), {}, transport, record)).rejects.toThrow('SERVER_STARTUP_FAILED');
  expect(closed).toBe(true);
  expect(entries[0]).toMatchObject({ type: 'test-abort', stage: 'server-startup', errorCode: 'EADDRINUSE', requestStarted: false });
  await expect(transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true))).rejects.toThrow('REQUEST_AFTER_ABORT');
  expect(transport.state.providerRequestFailed).toBe(false);
});

for (const status of [500, 401]) {
  test(`provider HTTP ${status} blocks next dispatch`, async () => {
    let calls = 0;
    const { transport } = isolation(async () => { calls++; return new Response('', { status }); });
    expect((await transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true))).status).toBe(status);
    await expect(transport.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'))).rejects.toThrow('REQUEST_AFTER_FAILURE');
    expect(transport.state.providerRequestFailed).toBe(true);
    expect(calls).toBe(1);
  });
}

test('provider HTTP 200 does not set failed flag', async () => {
  const { transport } = isolation();
  await transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true));
  expect(transport.state).toMatchObject({ halted: false, providerRequestFailed: false, abortReason: null });
});

test('Research gate failure stops E2E but is not a provider failure', async () => {
  const { transport, logs, entries } = isolation();
  await transport.fetch(`${config.baseUrl}/messages`, requestOptions('research', true));
  logs.warn('research gate', { failureStage: 'search-results', failureReason: 'PATENT_RESULTS_MISSING', searchResultCount: 0, body: 'private' });
  await expect(transport.fetch(`${config.baseUrl}/chat/completions`, requestOptions('primary'))).rejects.toThrow('REQUEST_AFTER_ABORT');
  expect(transport.state.providerRequestFailed).toBe(false);
  expect(entries).toContainEqual({ type: 'research-diagnostics', failureStage: 'search-results', failureReason: 'PATENT_RESULTS_MISSING', searchResultCount: 0 });
});

test('sanitized server diagnostic retains known error code and local origin only', () => {
  const entry = serverDiagnostic(['Error: ECONNRESET Bearer private'], { researchRequests: 1, generationRequests: 0, providerRequestFailed: false },
    'at handler (/private/work/server/example.ts:12:4)');
  expect(entry).toMatchObject({ errorCode: 'ECONNRESET', source: 'server/example.ts:12:4', requestStarted: true });
  expect(JSON.stringify(entry)).not.toMatch(/Bearer|private\/work/u);
});
