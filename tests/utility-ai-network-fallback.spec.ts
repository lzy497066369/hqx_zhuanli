import { test, expect } from '@playwright/test';
import { ATTEMPT_TIMEOUT_CAP_MS, aiProviders, attemptTimeoutMs, availableProviders, isTransientNetworkError, markProviderSucceeded } from '../server/aiSupport';
import type { AiConfig } from '../server/aiSupport';
import { chatJson } from '../server/patentStructureAi';

// 背景：局域网部署里文本模型经中转站生成几分钟才回响应头，Node 自带 undici 在 300 秒无响应头时抛普通 TypeError
// （fetch failed / UND_ERR_HEADERS_TIMEOUT），不是 AiFailure。之前这类错误不切换备用模型、不进冷却、不记日志，
// 前端只看到「文本模型连接失败」。这里固定两件事：连接层故障要切换备用模型；单次尝试超时必须早于 undici 的 300 秒。

const envelope = (content: unknown = { ok: true }) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
const headersTimeout = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT', name: 'HeadersTimeoutError' }) });
// 每个用例用独立的服务地址，避免进程级的 provider 冷却表在用例之间串扰。
function makeConfig(name: string): AiConfig {
  return { baseUrl: `https://${name}.example/v1`, apiKey: 'unit-test-private-key', model: 'primary-model', fallbackModel: 'fallback-model', secondFallbackModel: 'second-model' } as AiConfig;
}
test.beforeEach(() => { for (const name of ['net-fallback', 'net-all-fail', 'syntax', 'abort']) for (const provider of aiProviders(makeConfig(name))) markProviderSucceeded(provider); });

test('连接层故障（undici 300 秒无响应头）会切换到备用模型，并把故障模型打进冷却', async () => {
  const config = makeConfig('net-fallback');
  const models: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string; models.push(model);
    if (model === 'primary-model') throw headersTimeout();
    return envelope();
  };
  const result = await chatJson('prompt', { input: 1 }, config, new AbortController().signal, fetcher, 100);
  expect(result.model).toBe('fallback-model'); expect(result.value).toEqual({ ok: true });
  expect(models).toEqual(['primary-model', 'fallback-model']);
  expect(availableProviders(aiProviders(config)).map(provider => provider.model)).toEqual(['fallback-model', 'second-model']);
});

test('全部模型都连接失败时抛出原始网络错误，由各阶段统一映射为 AI_NETWORK', async () => {
  const config = makeConfig('net-all-fail');
  const models: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => { models.push(JSON.parse(String(init?.body)).model); throw headersTimeout(); };
  await expect(chatJson('prompt', { input: 1 }, config, new AbortController().signal, fetcher, 100)).rejects.toBeInstanceOf(TypeError);
  expect(models).toEqual(['primary-model', 'fallback-model', 'second-model']);
});

test('内容解析错误与请求中止不属于连接层故障，不切换模型', async () => {
  const syntaxConfig = makeConfig('syntax');
  const syntaxCalls: string[] = [];
  await expect(chatJson('prompt', {}, syntaxConfig, new AbortController().signal, async (_url, init) => { syntaxCalls.push(JSON.parse(String(init?.body)).model); throw new SyntaxError('bad upstream body'); }, 100)).rejects.toBeInstanceOf(SyntaxError);
  expect(syntaxCalls).toEqual(['primary-model']);
  const abortConfig = makeConfig('abort');
  const abortCalls: string[] = [];
  const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  await expect(chatJson('prompt', {}, abortConfig, new AbortController().signal, async (_url, init) => { abortCalls.push(JSON.parse(String(init?.body)).model); throw abortError; }, 100)).rejects.toBe(abortError);
  expect(abortCalls).toEqual(['primary-model']);
  expect(isTransientNetworkError(headersTimeout())).toBe(true);
  expect(isTransientNetworkError(new SyntaxError('x'))).toBe(false);
  expect(isTransientNetworkError(abortError)).toBe(false);
});

test('单次尝试超时按模型数均分，但封顶在 undici 300 秒无响应头超时之前', () => {
  expect(ATTEMPT_TIMEOUT_CAP_MS).toBeLessThan(300_000);
  expect(attemptTimeoutMs(600_000, 0.95, 3)).toBe(190_000);
  expect(attemptTimeoutMs(600_000, 0.95, 2)).toBe(ATTEMPT_TIMEOUT_CAP_MS);
  expect(attemptTimeoutMs(600_000, 0.95, 1)).toBe(ATTEMPT_TIMEOUT_CAP_MS);
  expect(attemptTimeoutMs(120_000, 0.9, 1)).toBe(108_000);
  expect(attemptTimeoutMs(600_000, 0.95, 0)).toBe(ATTEMPT_TIMEOUT_CAP_MS);
});
