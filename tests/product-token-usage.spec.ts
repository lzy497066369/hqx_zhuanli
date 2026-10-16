import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withTokenUsage } from '../server/aiUsage';
import { createAiMiddleware } from '../server/drawingAi';
import { chatJson } from '../server/patentStructureAi';
import { createProductWorkflowService, PRODUCT_PATHS } from '../server/productWorkflowAi';
import { createProductWorkflow, isProductWorkflow } from '../src/features/product/productWorkflow';
import { isTokenUsage, normalizeTokenUsage, summarizeTokenUsage } from '../src/features/product/tokenUsage';
import type { TokenUsage } from '../src/features/product/tokenUsage';
import { imageBytes, logicalResult, makeBrief, makeCad, makeMaterials, makePreview, makeReview, makeWorkflow, productConfig, productProject, productSelection } from './fixtures/productWorkflow';
import { makeTextStructure, makeTextDraft } from './fixtures/productText';

const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
const record = (counts = usage): TokenUsage => ({ id: randomUUID(), model: 'test-model', ...normalizeTokenUsage(counts) });
function completion(value: unknown, counts: unknown = usage) {
  return new Response(JSON.stringify({ usage: counts, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
}
function stream(value: unknown, counts: unknown = usage, finish = 'stop') {
  const text = [
    { usage: null, choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
    // Usage arrives after the final choice, with an empty choices array.
    { choices: [], usage: counts }, { choices: [], usage: counts },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('Token 统计区分未知与零、兼容输入输出字段，缓存与推理明细不重复相加', () => {
  expect(normalizeTokenUsage({ ...usage, completion_tokens_details: { reasoning_tokens: 20 }, prompt_tokens_details: { cached_tokens: 80 } })).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  expect(normalizeTokenUsage({ input_tokens: 10, output_tokens: 20 })).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  expect(normalizeTokenUsage(undefined).totalTokens).toBeNull();
  expect(normalizeTokenUsage({ total_tokens: 0 }).totalTokens).toBe(0);
  expect(normalizeTokenUsage({ total_tokens: -1, input_tokens: '100' }).totalTokens).toBeNull();
  const entry = record();
  expect(summarizeTokenUsage([entry, entry]).totalTokens).toBe(150);
  expect(summarizeTokenUsage([entry, { ...record(), inputTokens: null, outputTokens: null, totalTokens: null }])).toMatchObject({ totalTokens: 150, missingCalls: 1, inputTokens: null });
  expect(isTokenUsage({ ...entry, totalTokens: -1 })).toBe(false);
  const workflow = makeWorkflow(true);
  workflow.tokenUsage = [entry];
  expect(isProductWorkflow(JSON.parse(JSON.stringify(workflow)))).toBe(true);
  delete workflow.tokenUsage;
  expect(isProductWorkflow(workflow)).toBe(true);
});

test('流式末尾 usage 与自动修正累计，重复 usage 块每次请求只计一次', async () => {
  const records: TokenUsage[] = [];
  let calls = 0;
  const result = await withTokenUsage(item => records.push(item), () => chatJson('test', {}, productConfig, new AbortController().signal, async (_url, init) => {
    expect(JSON.parse(String(init?.body)).stream_options).toEqual({ include_usage: true });
    calls++;
    return stream({ valid: calls === 2, text: '结构' });
  }, 1000, undefined, value => (value as { valid: boolean }).valid, { validationRetry: { maxTokens: 1000, prompt: () => 'repair' } }));
  expect(result.value).toMatchObject({ valid: true });
  expect(records).toHaveLength(2);
  expect(summarizeTokenUsage(records)).toEqual({ inputTokens: 200, outputTokens: 100, totalTokens: 300, missingCalls: 0 });
});

test('失败调用保留已返回的用量，无用量的备用模型不冒充零消耗', async () => {
  const records: TokenUsage[] = [];
  let calls = 0;
  await withTokenUsage(item => records.push(item), () => chatJson('test', {}, { ...productConfig, fallbackModel: 'fallback-model' }, new AbortController().signal, async () => {
    calls++;
    return calls === 1 ? stream({}, usage, 'length') : completion({ valid: true }, null);
  }, 1000));
  expect(records).toHaveLength(2);
  expect(summarizeTokenUsage(records)).toMatchObject({ totalTokens: 150, missingCalls: 1 });
});

test('并行预览用量隔离，命中缓存不产生新用量', async () => {
  const groups: TokenUsage[][] = [[], []];
  const service = createProductWorkflowService(productConfig, async () => new Response(JSON.stringify({ usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 }, data: [{ b64_json: imageBytes.toString('base64') }] })));
  const briefs = [makeBrief(makeReview(), 'usage-brief-a'), makeBrief(makeReview(), 'usage-brief-b')];
  await Promise.all(briefs.map((brief, index) => withTokenUsage(item => groups[index].push(item), () => service(PRODUCT_PATHS.preview, { brief }, new AbortController().signal))));
  for (const records of groups) { expect(records).toHaveLength(4); expect(summarizeTokenUsage(records).totalTokens).toBe(200); }
  const cached: TokenUsage[] = [];
  await withTokenUsage(item => cached.push(item), () => service(PRODUCT_PATHS.preview, { brief: briefs[0] }, new AbortController().signal));
  expect(cached).toEqual([]);
});

test('产品 API 流式和 JSON 响应均输出用量，签名结果仍有效', async () => {
  const middleware = createAiMiddleware(productConfig, async () => completion(logicalResult()));
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const accept of ['application/x-ndjson', 'application/json']) {
      const response = await fetch(base + PRODUCT_PATHS.review, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept }, body: JSON.stringify({ selection: productSelection }) });
      expect(response.ok).toBe(true);
      if (accept === 'application/x-ndjson') {
        const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
        expect(events.filter(event => event.type === 'usage')).toHaveLength(1);
        expect(events.find(event => event.type === 'usage').usage.totalTokens).toBe(150);
        expect(events.at(-1).data.signature).toBeTruthy();
      } else {
        expect(JSON.parse(decodeURIComponent(response.headers.get('X-AI-Token-Usage')!))[0].totalTokens).toBe(150);
        const review = await response.json();
        expect(review).not.toHaveProperty('tokenUsage');
        // Verification runs before the mocked brief is rejected, so a proof error must not occur.
        const brief = await fetch(base + PRODUCT_PATHS.brief, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review }) });
        expect((await brief.json()).error.code).toBe('AI_INVALID_OUTPUT');
      }
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('专利生成后顶部显示累计用量，失败重试继续累计，刷新和手机布局正常', async ({ page }, testInfo) => {
  await page.addInitScript(project => {
    if (!localStorage.getItem('zhichuang-projects-v1')) localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project]));
  }, { ...productProject, productWorkflow: createProductWorkflow(productProject) });
  await page.route('**/api/generation/**', route => route.fulfill({ json: route.request().url().endsWith('/begin') ? { token: 'usage-test' } : { success: true } }));
  let materialCalls = 0;
  const records: TokenUsage[] = [];
  await page.route('**/api/product/**', async route => {
    const stage = route.request().url().split('/').at(-1);
    const body = route.request().postDataJSON();
    let result: unknown;
    if (stage === 'review') result = makeReview(body.selection);
    else if (stage === 'structure') result = makeTextStructure(body.review);
    else if (stage === 'brief') result = makeBrief(body.review);
    else if (stage === 'preview') result = makePreview(body.brief);
    else if (stage === 'confirm') result = makeWorkflow(true).confirmation;
    else if (stage === 'cad') result = makeCad(body.brief);
    else if (stage === 'draft') result = makeTextDraft(body.brief);
    else if (stage === 'materials') { materialCalls++; result = makeMaterials(body.brief); }
    else throw new Error(`Unexpected stage: ${stage}`);
    const current = stage === 'confirm' ? [] : Array.from({ length: stage === 'preview' ? 4 : 1 }, () => record());
    records.push(...current);
    const events = current.flatMap(usage => [{ type: 'usage', usage }, { type: 'usage', usage }]);
    const final = stage === 'materials' && materialCalls === 1
      ? { type: 'error', error: { code: 'AI_INVALID_OUTPUT', message: '测试文案校验失败' } }
      : { type: 'result', data: result };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [...events, final].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  await page.goto(`/#utility/${productProject.id}`);
  await page.getByRole('button', { name: '确认预览并生成成品', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('测试文案校验失败');
  await expect(page.getByTestId('token-usage')).toContainText('1,500');
  await page.getByRole('button', { name: '重试未完成的文案或附图', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载 Word 成品（.docx）', exact: true })).toBeEnabled();
  expect(records).toHaveLength(11);
  await expect(page.getByTestId('token-usage')).toContainText('1,650');
  await expect(page.getByTestId('token-usage')).toContainText('输入 1,100');
  await expect(page.getByTestId('token-usage')).toContainText('输出 550');
  await page.screenshot({ path: testInfo.outputPath('token-usage-desktop.png'), fullPage: true });
  await page.reload();
  await expect(page.getByTestId('token-usage')).toContainText('1,650');
  expect(materialCalls).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('token-usage-mobile.png'), fullPage: true });
});

for (const missing of [false, true]) test(`历史项目与接口缺失用量不显示为零（missing=${missing}）`, async ({ page }) => {
  const workflow = makeWorkflow(true);
  if (missing) workflow.tokenUsage = [{ ...record(), inputTokens: null, outputTokens: null, totalTokens: null }];
  else delete workflow.tokenUsage;
  await page.addInitScript(project => localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project])), { ...productProject, productWorkflow: workflow });
  await page.goto(`/#utility/${productProject.id}`);
  await expect(page.getByTestId('token-usage')).toContainText(missing ? '未提供' : '未记录');
  if (missing) await expect(page.getByTestId('token-usage')).toContainText('1 次调用未返回');
});
