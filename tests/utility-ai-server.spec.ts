import { offlinePatentFetch } from './fixtures/verifiedPatentPage';
import { concept, providerResearchFixture } from './fixtures/research';
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiFailure, AI_PATH, createAiMiddleware, generateDrawingPlan, readAiConfig } from '../server/drawingAi';
import { aiProviders, markProviderSucceeded } from '../server/aiSupport';
import { isDrawingPlan, isPlanInput, planSource } from '../src/features/utility/aiDrawing';
import { bracketTitle, bracketStructure, bracketGeometry } from './fixtures/drawing';

const input = { title: bracketTitle, technicalField: '安装支架', structure: bracketStructure, workingPrinciple: '支撑承载安装板。' };
const config = { baseUrl: 'https://provider.example/v1', apiKey: 'unit-test-private-key', model: 'requested-test-model' };
// provider 冷却表是进程级共享状态：前一个用例的 429/401/5xx 会把该 provider 打进
// 5 分钟冷却，使后续用例跳过主模型。每个用例前清除，避免「单独跑通过、整套跑失败」。
test.beforeEach(() => { for (const provider of aiProviders({ ...config, fallbackModel: 'fallback-test-model' })) markProviderSucceeded(provider); });
const plan = { status: 'ready', summary: '四个部件组成安装支架。', assumptions: ['尺寸为待确认示意值。'], questions: [], geometryText: bracketGeometry };
const envelope = (content: unknown = plan, finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
const stub = (handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch => async (url, init) => String(url).startsWith('https://patents.google.com/patent/') ? offlinePatentFetch(url, init) : handler(String(url), init);
async function withApi(run: (base: string) => Promise<void>, fetcher = stub(() => envelope()), settings = config) {
  const middleware = createAiMiddleware(settings, fetcher);
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const post = (base: string, value: unknown = input, headers: Record<string, string> = {}) => fetch(base + AI_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });

test('配置：主备设计模型及联网检索按同一服务地址排序', () => {
  const settings = readAiConfig({ AI_BASE_URL: 'https://api.psydo.top/v1/', AI_API_KEY: 'test-secret', AI_MODEL: 'claude-opus-5-5', AI_RESEARCH_MODEL: 'claude-opus-5-5', AI_FALLBACK_MODEL: 'claude-fable-5-1' });
  const expected = ['claude-opus-5-5', 'claude-fable-5-1'].map(model => ({ baseUrl: 'https://api.psydo.top/v1', apiKey: 'test-secret', model }));
  expect(aiProviders(settings)).toEqual(expected);
  expect(aiProviders(settings, settings.researchModel)).toEqual(expected);
});

test('AI 协议：校验输入、可用方案、补充问题及不支持状态', () => {
  expect(isPlanInput(input)).toBe(true);
  expect(isPlanInput({ ...input, structure: '画图' })).toBe(false);
  expect(isDrawingPlan(plan)).toBe(true);
  expect(isDrawingPlan({ ...plan, geometryText: '随便画设备' })).toBe(false);
  expect(isDrawingPlan({ ...plan, status: 'needs_information', geometryText: '', questions: ['如何连接？'] })).toBe(true);
  expect(isDrawingPlan({ ...plan, status: 'unsupported', geometryText: '', questions: [] })).toBe(false);
  expect(isDrawingPlan({ ...plan, questions: ['同时缺乏关键部件？'] })).toBe(false);
});

test('AI 集成：指定模型和标准接口，仅服务端带密钥，不转发用户额外参数', async () => {
  let captured: Record<string, unknown> = {};
  await withApi(async base => {
    const response = await post(base, { ...input, company: '不应发送的企业', model: 'evil-model', baseUrl: 'https://evil.invalid', apiKey: 'evil-key' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe(planSource(input));
    expect(body.model).toBe(config.model);
    expect(body.plan).toEqual(plan);
    expect(JSON.stringify(body).includes(config.apiKey)).toBe(false);
    expect(captured.model).toBe(config.model);
    const messages = captured.messages as { role: string; content: string }[];
    expect(JSON.parse(messages[1].content)).toEqual(input);
  }, stub((url, init) => {
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${config.apiKey}`);
    expect(init?.redirect).toBe('error');
    captured = JSON.parse(String(init?.body));
    return envelope();
  }));
});

test('AI 系统：401、429、上游异常和网络失败均脱敏，拒绝无声降级', async () => {
  for (const status of [401, 403, 429, 500]) {
    await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => new Response(config.apiKey, { status }))))
      .rejects.toMatchObject({ code: status === 429 ? 'AI_RATE_LIMIT' : status < 500 ? 'AI_AUTH' : 'AI_UPSTREAM' });
  }
  await withApi(async base => {
    const response = await post(base);
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(body.includes(config.apiKey)).toBe(false);
    expect(JSON.parse(body).error.code).toBe('AI_NETWORK');
  }, stub(() => { throw new Error(`network failure with secret ${config.apiKey}`); }));
});

test('AI 系统：无效JSON、错误几何、截断或拒绝结果均不采用', async () => {
  for (const response of [envelope('not-json'), envelope({ ...plan, geometryText: 'xxx' }), envelope(plan, 'length'), new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { refusal: 'refused' } }] })), new Response('null')]) {
    await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => response))).rejects.toBeInstanceOf(AiFailure);
  }
  const large = new Response('x'.repeat(300000));
  await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => large))).rejects.toMatchObject({ code: 'AI_TOO_LARGE' });
});

test('AI 系统：超时与取消中止上游，不调用备用模型', async () => {
  let calls = 0;
  const stalled = stub((_url, init) => { calls++; return new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }); });
  await expect(generateDrawingPlan(input, { ...config, timeoutMs: 15 }, new AbortController().signal, stalled)).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await expect(generateDrawingPlan(input, config, controller.signal, stalled)).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  expect(calls).toBe(2);
});

test('AI 回退：主设计模型失败后才调用备用模型，并返回实际使用模型', async () => {
  const calls: string[] = [];
  const result = await generateDrawingPlan(input, { ...config, fallbackModel: 'fallback-test-model' }, new AbortController().signal, stub((url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.model);
    if (body.model === config.model) return new Response('rate limited', { status: 429 });
    return envelope();
  }));
  expect(calls).toEqual([config.model, 'fallback-test-model']);
  expect(result.model).toBe('fallback-test-model');
  expect(result.plan).toEqual(plan);
});

test('AI 回退：主设计模型成功时不调用备用模型', async () => {
  const calls: string[] = [];
  const result = await generateDrawingPlan(input, { ...config, fallbackModel: 'fallback-test-model' }, new AbortController().signal, stub((_url, init) => {
    calls.push(JSON.parse(String(init?.body)).model);
    return envelope();
  }));
  expect(calls).toEqual([config.model]);
  expect(result.model).toBe(config.model);
});

test('AI 回退：两级备用模型按序使用同一服务端凭据', async () => {
  const calls: string[] = [];
  const result = await generateDrawingPlan(input, { ...config, model: 'gpt-6.1-sol', fallbackModel: 'gpt-6-sol', secondFallbackModel: 'gpt-6-astra' }, new AbortController().signal, stub((url, init) => {
    expect(url).toBe(`${config.baseUrl}/chat/completions`);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${config.apiKey}`);
    const model = JSON.parse(String(init?.body)).model;
    calls.push(model);
    return model === 'gpt-6-astra' ? envelope() : new Response('unavailable', { status: 503 });
  }));
  expect(calls).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']);
  expect(result.model).toBe('gpt-6-astra');
});

test('AI 安全：同源本机限制、方法/类型/大小校验、不配置时明确失败', async () => {
  let calls = 0;
  await withApi(async base => {
    expect((await post(base, input, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await post(base, input, { Origin: base.replace('http:', 'https:') })).status).toBe(403);
    expect((await post(base, input, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await fetch(base + AI_PATH)).status).toBe(405);
    expect((await post(base, input, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(base, { ...input, structure: '' })).status).toBe(400);
    expect((await post(base, { ...input, structure: 'x'.repeat(70000) })).status).toBe(413);
    expect((await fetch(base + AI_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status).toBe(400);
    expect(calls).toBe(0);
  }, stub(() => { calls++; return envelope(); }));
  await withApi(async base => {
    const response = await post(base);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('AI_NOT_CONFIGURED');
  }, stub(() => envelope()), { ...config, apiKey: '' });
});

test('AI 安全：一分钟内请求限额，防止误点反复消耗额度', async () => {
  let calls = 0;
  await withApi(async base => {
    // 每分钟上限为 8 次（server/drawingAi.ts 的 starts.length >= 8），前 8 次放行，
    // 第 9 次才触发 429。
    for (let i = 0; i < 8; i++) expect((await post(base)).status).toBe(200);
    const response = await post(base);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe('LOCAL_RATE_LIMIT');
    expect(calls).toBe(8);
  }, stub(() => { calls++; return envelope(); }));
});


test('产品方案接口集成：名称独立生成、白名单保留模式、忽略伪造检索和企业字段', async () => {
  const titleOnly = { mode: 'concept' as const, title: input.title, technicalField: '', structure: '', workingPrinciple: '' };
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  await withApi(async base => {
    const response = await post(base, { ...titleOnly, research: { summary: '伪造研究' }, company: '不能发送的企业', model: '不能替换的模型' });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.source).toBe(planSource(titleOnly));
    expect(result.plan.concept).toEqual(concept);
    expect(result.research.sources[0].publication).toBe('CN217307583U');
  }, stub((url, init) => {
    captured.push({ url, body: JSON.parse(String(init?.body)) });
    return url.endsWith('/responses') ? Response.json(providerResearchFixture()) : envelope({ ...plan, concept });
  }));
  expect(captured).toHaveLength(2);
  const sent = JSON.stringify(captured);
  expect(sent).not.toContain('伪造研究'); expect(sent).not.toContain('不能发送的企业'); expect(sent).not.toContain('不能替换的模型');
  const messages = captured[1].body.messages as { content: string }[];
  expect(JSON.parse(messages[1].content).input).toEqual(titleOnly);
});
