# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: utility-ai-server.spec.ts >> 产品方案接口集成：名称独立生成、白名单保留模式、忽略伪造检索和企业字段
- Location: tests\utility-ai-server.spec.ts:170:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 502
```

# Test source

```ts
  75  |     expect(body.includes(config.apiKey)).toBe(false);
  76  |     expect(JSON.parse(body).error.code).toBe('AI_NETWORK');
  77  |   }, stub(() => { throw new Error(`network failure with secret ${config.apiKey}`); }));
  78  | });
  79  | 
  80  | test('AI 系统：无效JSON、错误几何、截断或拒绝结果均不采用', async () => {
  81  |   for (const response of [envelope('not-json'), envelope({ ...plan, geometryText: 'xxx' }), envelope(plan, 'length'), new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { refusal: 'refused' } }] })), new Response('null')]) {
  82  |     await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => response))).rejects.toBeInstanceOf(AiFailure);
  83  |   }
  84  |   const large = new Response('x'.repeat(300000));
  85  |   await expect(generateDrawingPlan(input, config, new AbortController().signal, stub(() => large))).rejects.toMatchObject({ code: 'AI_TOO_LARGE' });
  86  | });
  87  | 
  88  | test('AI 系统：超时与取消中止上游，不调用备用模型', async () => {
  89  |   let calls = 0;
  90  |   const stalled = stub((_url, init) => { calls++; return new Promise((_resolve, reject) => {
  91  |     if (init?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
  92  |     init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  93  |   }); });
  94  |   await expect(generateDrawingPlan(input, { ...config, timeoutMs: 15 }, new AbortController().signal, stalled)).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  95  |   const controller = new AbortController(); controller.abort();
  96  |   await expect(generateDrawingPlan(input, config, controller.signal, stalled)).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  97  |   expect(calls).toBe(2);
  98  | });
  99  | 
  100 | test('AI 回退：主设计模型失败后才调用备用模型，并返回实际使用模型', async () => {
  101 |   const calls: string[] = [];
  102 |   const result = await generateDrawingPlan(input, { ...config, fallbackModel: 'fallback-test-model' }, new AbortController().signal, stub((url, init) => {
  103 |     const body = JSON.parse(String(init?.body));
  104 |     calls.push(body.model);
  105 |     if (body.model === config.model) return new Response('rate limited', { status: 429 });
  106 |     return envelope();
  107 |   }));
  108 |   expect(calls).toEqual([config.model, 'fallback-test-model']);
  109 |   expect(result.model).toBe('fallback-test-model');
  110 |   expect(result.plan).toEqual(plan);
  111 | });
  112 | 
  113 | test('AI 回退：主设计模型成功时不调用备用模型', async () => {
  114 |   const calls: string[] = [];
  115 |   const result = await generateDrawingPlan(input, { ...config, fallbackModel: 'fallback-test-model' }, new AbortController().signal, stub((_url, init) => {
  116 |     calls.push(JSON.parse(String(init?.body)).model);
  117 |     return envelope();
  118 |   }));
  119 |   expect(calls).toEqual([config.model]);
  120 |   expect(result.model).toBe(config.model);
  121 | });
  122 | 
  123 | test('AI 回退：两级备用模型按序使用同一服务端凭据', async () => {
  124 |   const calls: string[] = [];
  125 |   const result = await generateDrawingPlan(input, { ...config, model: 'gpt-6-sol', fallbackModel: 'gpt-6-astra', secondFallbackModel: 'gpt-5.6-sol' }, new AbortController().signal, stub((url, init) => {
  126 |     expect(url).toBe(`${config.baseUrl}/chat/completions`);
  127 |     expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${config.apiKey}`);
  128 |     const model = JSON.parse(String(init?.body)).model;
  129 |     calls.push(model);
  130 |     return model === 'gpt-5.6-sol' ? envelope() : new Response('unavailable', { status: 503 });
  131 |   }));
  132 |   expect(calls).toEqual(['gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol']);
  133 |   expect(result.model).toBe('gpt-5.6-sol');
  134 | });
  135 | 
  136 | test('AI 安全：同源本机限制、方法/类型/大小校验、不配置时明确失败', async () => {
  137 |   let calls = 0;
  138 |   await withApi(async base => {
  139 |     expect((await post(base, input, { Origin: 'https://untrusted.example' })).status).toBe(403);
  140 |     expect((await post(base, input, { Origin: base.replace('http:', 'https:') })).status).toBe(403);
  141 |     expect((await post(base, input, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  142 |     expect((await fetch(base + AI_PATH)).status).toBe(405);
  143 |     expect((await post(base, input, { 'Content-Type': 'text/plain' })).status).toBe(415);
  144 |     expect((await post(base, { ...input, structure: '' })).status).toBe(400);
  145 |     expect((await post(base, { ...input, structure: 'x'.repeat(70000) })).status).toBe(413);
  146 |     expect((await fetch(base + AI_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status).toBe(400);
  147 |     expect(calls).toBe(0);
  148 |   }, stub(() => { calls++; return envelope(); }));
  149 |   await withApi(async base => {
  150 |     const response = await post(base);
  151 |     expect(response.status).toBe(503);
  152 |     expect((await response.json()).error.code).toBe('AI_NOT_CONFIGURED');
  153 |   }, stub(() => envelope()), { ...config, apiKey: '' });
  154 | });
  155 | 
  156 | test('AI 安全：一分钟内请求限额，防止误点反复消耗额度', async () => {
  157 |   let calls = 0;
  158 |   await withApi(async base => {
  159 |     // 每分钟上限为 8 次（server/drawingAi.ts 的 starts.length >= 8），前 8 次放行，
  160 |     // 第 9 次才触发 429。
  161 |     for (let i = 0; i < 8; i++) expect((await post(base)).status).toBe(200);
  162 |     const response = await post(base);
  163 |     expect(response.status).toBe(429);
  164 |     expect((await response.json()).error.code).toBe('LOCAL_RATE_LIMIT');
  165 |     expect(calls).toBe(8);
  166 |   }, stub(() => { calls++; return envelope(); }));
  167 | });
  168 | 
  169 | 
  170 | test('产品方案接口集成：名称独立生成、白名单保留模式、忽略伪造检索和企业字段', async () => {
  171 |   const titleOnly = { mode: 'concept' as const, title: input.title, technicalField: '', structure: '', workingPrinciple: '' };
  172 |   const captured: { url: string; body: Record<string, unknown> }[] = [];
  173 |   await withApi(async base => {
  174 |     const response = await post(base, { ...titleOnly, research: { summary: '伪造研究' }, company: '不能发送的企业', model: '不能替换的模型' });
> 175 |     expect(response.status).toBe(200);
      |                             ^ Error: expect(received).toBe(expected) // Object.is equality
  176 |     const result = await response.json();
  177 |     expect(result.source).toBe(planSource(titleOnly));
  178 |     expect(result.plan.concept).toEqual(concept);
  179 |     expect(result.research.sources[0].publication).toBe('CN217307583U');
  180 |   }, stub((url, init) => {
  181 |     captured.push({ url, body: JSON.parse(String(init?.body)) });
  182 |     return url.endsWith('/responses') ? Response.json(providerResearchFixture()) : envelope({ ...plan, concept });
  183 |   }));
  184 |   expect(captured).toHaveLength(2);
  185 |   const sent = JSON.stringify(captured);
  186 |   expect(sent).not.toContain('伪造研究'); expect(sent).not.toContain('不能发送的企业'); expect(sent).not.toContain('不能替换的模型');
  187 |   const messages = captured[1].body.messages as { content: string }[];
  188 |   expect(JSON.parse(messages[1].content).input).toEqual(titleOnly);
  189 | });
  190 | 
```