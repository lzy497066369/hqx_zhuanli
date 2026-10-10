import { test, expect } from '@playwright/test';
import { generateDrawingPlan } from '../server/drawingAi';
import { parseOfflineResearch as parseResearch, offlinePatentFetch } from './fixtures/verifiedPatentPage';
import { isPlanInput, planSource } from '../src/features/utility/aiDrawing';
import { isPatentResearch, patentUrl } from '../src/features/utility/patentResearch';
import { isContentDesign } from '../src/features/utility/contentDrawing';
import { concept, providerResearchFixture, researchFixture } from './fixtures/research';
import { bracketTitle, bracketGeometry, drawingFixture } from './fixtures/drawing';

const input = { mode: 'concept' as const, title: bracketTitle, technicalField: '', structure: '', workingPrinciple: '' };
const config = { baseUrl: 'https://provider.example/v1', apiKey: 'test-server-only', model: 'configured-model' };
const plan = { status: 'ready', summary: 'AI拟议支架方案，待验证。', assumptions: ['全部尺寸为拟议示意值。'], questions: [], geometryText: bracketGeometry, concept };
const stub = (handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch => async (url, init) => init?.method === 'GET' ? offlinePatentFetch(url, init) : handler(String(url), init);
const completion = (value: unknown = plan) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });

test('产品方案协议：只需名称，旧手工契约仍校验结构；检索和概念元数据可保存恢复', async () => {
  expect(isPlanInput(input)).toBe(true);
  expect(isPlanInput({ ...input, title: '' })).toBe(false);
  expect(isPlanInput({ ...input, mode: 'invented' })).toBe(false);
  expect(isPlanInput({ ...input, mode: undefined })).toBe(false);
  const fixture = drawingFixture().design!;
  expect(isContentDesign({ ...fixture, ai: { model: config.model, source: planSource(input), generatedAt: new Date().toISOString(), summary: plan.summary, assumptions: plan.assumptions, research: researchFixture(input), concept } })).toBe(true);
  expect(isContentDesign({ ...fixture, ai: { model: config.model, source: planSource(input), generatedAt: new Date().toISOString(), summary: plan.summary, assumptions: [], concept: { ...concept, structure: '' } } })).toBe(false);
});

test('产品方案集成：真实检索工具→可溯源引用→具体产品与几何；不把结构约束用于公开检索', async () => {
  const calls: string[] = [];
  const privateInput = { ...input, structure: '仅用于方案设计的私有约束说明' };
  const result = await generateDrawingPlan(privateInput, config, new AbortController().signal, stub((url, init) => {
    calls.push(url);
    const body = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${config.apiKey}`);
    expect(new Headers(init?.headers).get('User-Agent')).toBe('zhichuang-workshop/1.0');
    expect(body.model).toBe(config.model);
    expect(init?.redirect).toBe('error');
    if (url.endsWith('/responses')) {
      expect(body.tools[0].type).toBe('web_search');
      expect(body.include).toContain('web_search_call.action.sources');
      expect(JSON.parse(body.input)).toEqual({ title: input.title, technicalField: '' });
      expect(JSON.stringify(body)).not.toContain(privateInput.structure);
      return Response.json(providerResearchFixture());
    }
    const payload = JSON.parse(body.messages[1].content);
    expect(payload.input).toEqual(privateInput);
    expect(payload.research.sources[0].publication).toBe('CN217307583U');
    expect(body.messages[0].content).toContain('明确委托你提出一个具体产品');
    return completion();
  }));
  expect(calls).toEqual([config.baseUrl + '/responses', config.baseUrl + '/chat/completions']);
  expect(result.plan.concept).toEqual(concept);
  expect(result.research?.sources[0].url).toBe('https://patents.google.com/patent/CN217307583U/en');
  expect(result.research?.sources[0].evidence).toBe('opened');
  expect(result.source).toBe(planSource(privateInput));
});

test('检索模型可独立于设计模型配置，避免不支持 Responses 检索的模型导致超时', async () => {
  let researchModel = '';
  await generateDrawingPlan(input, { ...config, researchModel: 'research-compatible-model' }, new AbortController().signal, stub((url, init) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/responses')) {
      researchModel = body.model;
      return Response.json(providerResearchFixture());
    }
    return completion();
  }));
  expect(researchModel).toBe('research-compatible-model');
});

test('联网检索回退：主检索模型限流后使用备用模型，成功后不回退设计模型', async () => {
  const calls: { path: string; model: string }[] = [];
  const result = await generateDrawingPlan(input, { ...config, researchModel: 'primary-research-model', fallbackModel: 'fallback-test-model' }, new AbortController().signal, stub((url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ path: url.endsWith('/responses') ? 'responses' : 'chat', model: body.model });
    if (url.endsWith('/responses') && body.model === 'primary-research-model') return new Response('rate limited', { status: 429 });
    return url.endsWith('/responses') ? Response.json(providerResearchFixture()) : completion();
  }));
  expect(calls).toEqual([
    { path: 'responses', model: 'primary-research-model' },
    { path: 'responses', model: 'fallback-test-model' },
    { path: 'chat', model: config.model },
  ]);
  expect(result.research?.sources[0].publication).toBe('CN217307583U');
  expect(result.model).toBe(config.model);
});

test('跨服务回退：检索使用备用服务，生成仍使用主服务', async () => {
  const primary = { ...config, model: 'claude-opus-5-5', researchModel: 'claude-opus-5-5', fallbackModel: 'gpt-6-sol', fallbackBaseUrl: 'https://research.example/v1', fallbackApiKey: 'research-key' };
  const calls: string[] = [];
  const result = await generateDrawingPlan(input, primary, new AbortController().signal, stub((url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    const auth = new Headers(init?.headers).get('Authorization');
    calls.push(`${url}:${model}:${auth}`);
    if (url === `${primary.baseUrl}/responses`) return new Response('unsupported', { status: 500 });
    if (url === `${primary.fallbackBaseUrl}/responses`) return Response.json(providerResearchFixture());
    return completion();
  }));
  expect(calls).toEqual([
    `${primary.baseUrl}/responses:claude-opus-5-5:Bearer ${primary.apiKey}`,
    `${primary.fallbackBaseUrl}/responses:gpt-6-sol:Bearer research-key`,
    `${primary.baseUrl}/chat/completions:claude-opus-5-5:Bearer ${primary.apiKey}`,
  ]);
  expect(result.model).toBe('claude-opus-5-5');
  expect(result.research?.sources[0].publication).toBe('CN217307583U');
});

test('联网检索回退：前两级不可用时尝试第二备用模型', async () => {
  const calls: string[] = [];
  const result = await generateDrawingPlan(input, { ...config, researchModel: 'gpt-6-astra', fallbackModel: 'gpt-6-sol', secondFallbackModel: 'gpt-5.6-sol' }, new AbortController().signal, stub((url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(`${url.endsWith('/responses') ? 'responses' : 'chat'}:${body.model}`);
    if (url.endsWith('/responses')) return body.model === 'gpt-5.6-sol' ? Response.json(providerResearchFixture()) : new Response('rate limited', { status: 429 });
    return completion();
  }));
  expect(calls).toEqual(['responses:gpt-6-astra', 'responses:gpt-6-sol', 'responses:gpt-5.6-sol', `chat:${config.model}`]);
  expect(result.research?.sources[0].publication).toBe('CN217307583U');
});

test('联网检索回退：主、备用模型均失败时仍阻止方案生成', async () => {
  const calls: string[] = [];
  await expect(generateDrawingPlan(input, { ...config, researchModel: 'primary-research-model', fallbackModel: 'fallback-test-model' }, new AbortController().signal, stub((url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(`${url.endsWith('/responses') ? 'responses' : 'chat'}:${body.model}`);
    return new Response('rate limited', { status: 429 });
  }))).rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE' });
  expect(calls).toEqual(['responses:primary-research-model', 'responses:fallback-test-model']);
});

test('检索验证：未联网、未完成、假引用、无来源不冒充已检索；危险地址拒绝', async () => {
  for (const url of ['http://patents.google.com/patent/CN217307583U/zh', 'https://patents.google.com.evil.test/patent/CN217307583U/zh', 'https://user:pass@patents.google.com/patent/CN217307583U/zh', 'javascript:alert(1)', 'https://127.0.0.1/patent/CN217307583U/zh']) expect(patentUrl(url)).toBeNull();
  expect(patentUrl('https://www.google.com/patents/CN217307583U?oq=CN217307583U')).toEqual({ url: 'https://patents.google.com/patent/CN217307583U/en', publication: 'CN217307583U' });
  expect(patentUrl('http://www.google.com/patents/CN217307583U?cl=zh')).toEqual({ url: 'https://patents.google.com/patent/CN217307583U/en', publication: 'CN217307583U' });
  for (const page of ['fi', 'ja', 'tr', 'adv_search.asp']) {
    expect(patentUrl(`https://patents.google.com/patent/CN217307583U/${page}`)).toEqual({ url: 'https://patents.google.com/patent/CN217307583U/en', publication: 'CN217307583U' });
  }
  const valid = providerResearchFixture();
  for (const invalid of [null, { ...valid, status: 'incomplete' }, { ...valid, output: valid.output.slice(2) }, { ...valid, output: valid.output.slice(0, 2) }, { ...valid, output: [null, 1, {}] }]) {
    await expect(parseResearch(invalid, input)).rejects.toThrow();
  }
  const fake = JSON.parse(JSON.stringify(valid));
  fake.output[2].content[0].annotations[0].url = 'https://patents.google.com/patent/CN000000001U/zh';
  await expect(parseResearch(fake, input)).rejects.toThrow();
  const searchOnly = { ...valid, output: [valid.output[0], valid.output[2]] };
  expect((await parseResearch(searchOnly, input)).sources[0].evidence).toBe('opened');
  expect((await parseResearch(valid, input)).facts).toMatchObject([{
    id: 'RSF-001', sourceId: 'CN217307583U', factType: 'PRIOR_ART_FEATURE', sourceType: 'PATENT', status: 'INFERRED',
    evidenceScope: 'PATENT_ORIGINAL_TEXT', relatedComponentIds: [], relatedConnectionIds: [],
    relatedMotionIds: [], relatedFigureIds: [],
  }]);
  expect(isPatentResearch({ ...researchFixture(input), sources: [null] })).toBe(false);
});

test('检索失败系统测试：清晰错误，不继续生成、不静默降级、不泄漏密钥', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => { calls++; return new Response(config.apiKey, { status }); })))
      .rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE' });
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => { calls++; return Response.json({ status: 'completed', output: [] }); })))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(calls).toBe(1);
});

test('检索错误反馈：识别上游限流和不支持联网检索，不泄漏上游正文', async () => {
  await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => Response.json({ error: { type: 'rate_limit_error', message: 'All available accounts are currently rate-limited' } }, { status: 429 }))))
    .rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE', message: expect.stringContaining('账户池正在限流') });
  await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => Response.json({ error: { type: 'invalid_request_error', message: 'web_search is not supported by this model' } }, { status: 400 }))))
    .rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE', message: expect.stringContaining('不支持 Responses 联网检索') });
});

test('概念结果系统测试：研究后缺结构/原理或几何错误均不采用', async () => {
  for (const invalid of [{ ...plan, concept: undefined }, { ...plan, concept: { ...concept, workingPrinciple: '' } }, { ...plan, geometryText: '错误几何' }]) {
    await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : completion(invalid))))
      .rejects.toMatchObject({ code: 'AI_INVALID_PLAN' });
  }
});

test('检索取消/超时：停止整个两阶段流程，不调用设计接口', async () => {
  let calls = 0;
  const stalled = stub((_url, init) => { calls++; return new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }); });
  await expect(generateDrawingPlan(input, { ...config, timeoutMs: 10 }, new AbortController().signal, stalled)).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await expect(generateDrawingPlan(input, config, controller.signal, stalled)).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  expect(calls).toBe(2);
});
