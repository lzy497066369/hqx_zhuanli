import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProductWorkflowService, PRODUCT_PATHS } from '../server/productWorkflowAi';
import { createAiMiddleware, readAiConfig } from '../server/drawingAi';
import { generateProductImage, isPublicImageAddress, validateImageUrl } from '../server/productImages';
import { resolveFreeCad } from '../server/productCad';
import { signProductArtifact } from '../server/productProof';
import { applyConflictChoices, imageReference, isProductWorkflow, isProductWorkflowComplete, isLogicResult, isProductDesign, isProductImage, isProductReview, previewReference, PREVIEW_VIEWS } from '../src/features/product/productWorkflow';
import type { ProductReview, ProductBrief, ProductCad, ProductMaterials, ProductPreview, PreviewConfirmation, RevisionResponse } from '../src/features/product/productWorkflow';
import { buildPatentFigurePrompt, buildPreviewPrompt, PATENT_FIGURE_TEMPLATES } from '../src/features/product/productPrompts';
import { documentContent, imageBytes, jsonEnvelope, logicalResult, makeBrief, makeDesign, makeImage, makePreview, makeReview, makeWorkflow, productConfig, productSelection, testCadScript } from './fixtures/productWorkflow';

const signal = () => new AbortController().signal;
const imageEnvelope = () => new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }));
function modelFetcher(calls: { url: string; payload: Record<string, unknown>; auth: string | null }[]): typeof fetch {
  return async (url, init) => {
    const payload = JSON.parse(String(init?.body || '{}'));
    calls.push({ url: String(url), payload, auth: new Headers(init?.headers).get('Authorization') });
    if (String(url).endsWith('/images/generations')) return imageEnvelope();
    const prompt = payload.messages[0].content as string;
    const user = payload.messages[1].content;
    const input = JSON.parse(typeof user === 'string' ? user : user[0].text);
    if (prompt.includes('产品方案逻辑审查助手')) return jsonEnvelope(logicalResult());
    if (prompt.includes('产品定义与专利技术交底助手')) return jsonEnvelope(makeDesign(input.selection));
    if (prompt.includes('CAD 建模助手')) return jsonEnvelope({ summary: '按简介建立底座模型。', assumptions: ['尺寸推定。'], script: testCadScript, keyStructure: { point: [60, 30, 44], radius: 12 } });
    return jsonEnvelope(documentContent);
  };
}
test('产品协议严格校验逻辑维度、特征覆盖、四张预览、CAD 附图、版本和持久化', () => {
  expect(isProductReview(makeReview())).toBe(true);
  expect(isLogicResult({ ...logicalResult(), checks: [] }, productSelection)).toBe(false);
  expect(isLogicResult({ ...logicalResult(true), verdict: 'feasible' }, productSelection)).toBe(false);
  expect(isProductDesign({ ...makeDesign(), choiceCoverage: [] }, productSelection)).toBe(false);
  expect(isProductImage({ ...makeImage(), dataUrl: 'https://remote/image.png' })).toBe(false);
  const workflow = makeWorkflow(true);
  expect(isProductWorkflow(workflow)).toBe(true); expect(isProductWorkflowComplete(workflow)).toBe(true);
  expect(isProductWorkflowComplete({ ...workflow, confirmation: undefined })).toBe(false);
  expect(isProductWorkflowComplete({ ...workflow, cad: undefined })).toBe(false);
  expect(isProductWorkflowComplete(makeWorkflow(true, 'image'))).toBe(true);
  expect(isProductWorkflowComplete({ ...workflow, brief: makeBrief(makeReview(), 'another-brief') })).toBe(false);
  expect(isProductWorkflow({ ...workflow, previews: { ...workflow.previews!, images: workflow.previews!.images.map(image => ({ ...image, dataUrl: 'javascript:alert(1)' })) } })).toBe(false);
  expect(isProductWorkflow({ ...workflow, previews: { ...workflow.previews!, images: workflow.previews!.images.slice(0, 3) } })).toBe(false);
  expect(isProductWorkflow({ ...workflow, cad: { ...workflow.cad!, views: [{ ...workflow.cad!.views[0], svg: '<script>alert(1)</script>' }] } })).toBe(false);
  expect(isProductWorkflow({ ...workflow, previous: { ...workflow, previous: workflow } })).toBe(false);
});
test('去矛盾只应用用户选中的明确删改，并阻止取舍之间的新冲突', () => {
  const review = makeReview(productSelection, true);
  expect(() => applyConflictChoices(review, {})).toThrow('每一项');
  const resolved = applyConflictChoices(review, { 'conflict-1': 'keep-fixed' });
  expect(resolved.choices.map(choice => choice.id)).not.toContain('feature-2');
  expect(resolved.proposedName).toContain('固定连接');
  const second = structuredClone(review.conflicts[0]); second.id = 'conflict-2'; second.options[0].removeIds = []; second.options[0].replacements = [{ id: 'feature-2', text: '保留滑动' }];
  expect(() => applyConflictChoices({ ...review, conflicts: [...review.conflicts, second] }, { 'conflict-1': 'keep-fixed', 'conflict-2': 'keep-fixed' })).toThrow('所选处理方案');
});
test('四个预览视角各自注入同一简介且只画一个视角；黑白模板仍只启用一张', () => {
  const brief = makeBrief();
  expect(PREVIEW_VIEWS.map(view => view.title)).toEqual(['主体图', '前视图', '俯视图', '右视图']);
  for (const view of PREVIEW_VIEWS) {
    const color = buildPreviewPrompt(brief, view.templateId);
    expect(color).toContain(brief.description); expect(color).toContain(view.requirement); expect(color).toContain(`只画${view.title}这一个视角`); expect(color).not.toMatch(/\{\{.+?\}\}/);
    expect(color).not.toContain('部件标号'); expect(color).toContain('不要在图中添加数字');
  }
  const patent = buildPatentFigurePrompt(brief, 'patent-structure');
  expect(patent).toContain(brief.description); expect(patent).toContain('不要爆炸图，不要额外添加多个视角'); expect(patent).toContain('1：轨道底座');
  expect(PATENT_FIGURE_TEMPLATES).toHaveLength(1);
  expect(() => buildPatentFigurePrompt(brief, 'fake-other-template')).toThrow();
  expect(() => buildPreviewPrompt(brief, 'color-preview')).toThrow();
  expect(buildPreviewPrompt({ ...brief, description: '$& $` $\' 原始简介' }, 'color-hero')).toContain('$& $` $\' 原始简介');
});
test('独立文本与生图密钥只在服务器配置，四张预览并行生成，确认后走 FreeCAD 附图与文案', async () => {
  const settings = readAiConfig({ AI_BASE_URL: productConfig.baseUrl, AI_API_KEY: productConfig.apiKey, AI_MODEL: productConfig.model,
    AI_IMAGE_BASE_URL: productConfig.image!.baseUrl, AI_IMAGE_API_KEY: productConfig.image!.apiKey, AI_IMAGE_MODEL: productConfig.image!.model });
  expect(settings.image).toEqual(productConfig.image);
  const calls: { url: string; payload: Record<string, unknown>; auth: string | null }[] = [];
  const service = createProductWorkflowService(settings, modelFetcher(calls));
  const review = await service(PRODUCT_PATHS.review, { selection: productSelection, apiKey: 'browser-key', model: 'browser-model' }, signal()) as ProductReview;
  expect(review.verdict).toBe('feasible');
  const brief = await service(PRODUCT_PATHS.brief, { review }, signal()) as ProductBrief;
  const preview = await service(PRODUCT_PATHS.preview, { brief, baseUrl: 'https://evil.example', apiKey: 'browser-key' }, signal()) as ProductPreview;
  expect(preview.images.map(image => image.templateId)).toEqual(PREVIEW_VIEWS.map(view => view.templateId));
  const again = await service(PRODUCT_PATHS.preview, { brief }, signal()) as ProductPreview;
  expect(again.id).toBe(preview.id);
  expect(calls.filter(call => call.url.endsWith('/images/generations'))).toHaveLength(4);
  const sentPrompts = calls.filter(call => call.url.endsWith('/images/generations')).map(call => String(call.payload.prompt));
  expect(new Set(sentPrompts).size).toBe(4); expect(sentPrompts.every(prompt => prompt.includes(brief.description))).toBe(true);
  await expect(service(PRODUCT_PATHS.figure, { brief, templateId: 'patent-structure' }, signal())).rejects.toMatchObject({ code: 'PREVIEW_CONFIRMATION_REQUIRED' });
  await expect(service(PRODUCT_PATHS.cad, { brief, images: [] }, signal())).rejects.toMatchObject({ code: 'PREVIEW_CONFIRMATION_REQUIRED' });
  const confirmation = await service(PRODUCT_PATHS.confirm, { brief, preview: previewReference(preview), confirmed: true }, signal()) as PreviewConfirmation;
  expect(confirmation.previewDigest).toBe(preview.digest);
  const freecad = await resolveFreeCad(settings);
  if (freecad) {
    const images = preview.images.map(image => ({ templateId: image.templateId, dataUrl: image.dataUrl }));
    const cad = await service(PRODUCT_PATHS.cad, { brief, confirmation, images }, signal()) as ProductCad;
    expect(cad.briefId).toBe(brief.id); expect(cad.views.map(view => view.title)).toEqual(['立体图', '前视图', '俯视图', '右视图']); expect(cad.script).toBe(testCadScript);
    expect(cad.views.every(view => view.svg.startsWith('<svg') && view.svg.includes('<path'))).toBe(true);
    // 标号来自网格的部件归属：每个视角只标可见部件，A 圈选只出现在立体图；标号记录与简介部件一一对应。
    expect(cad.views.find(view => view.view === 'iso')!.svg).toContain('>1<'); expect(cad.views.find(view => view.view === 'iso')!.svg).toContain('>2<');
    expect(cad.views.filter(view => view.svg.includes('<circle')).map(view => view.view)).toEqual(['iso']);
    expect(cad.labels.map(label => `${label.number} ${label.name}`)).toEqual(['1 轨道底座', '2 夹持座', '3 锁紧螺栓']);
    const vision = calls.find(call => String(call.payload.messages?.[0]?.content).includes('CAD 建模助手'))!;
    expect((vision.payload.messages as { content: unknown }[])[1].content).toHaveLength(5);
    const materials = await service(PRODUCT_PATHS.materials, { brief, confirmation }, signal()) as ProductMaterials;
    expect(materials.drawings).toContain('图1为本产品的立体图'); expect(materials.drawings).toContain('图4为本产品的右视图'); expect(materials.drawings).not.toContain('A为关键结构');
    expect(JSON.stringify(cad)).not.toContain('test-secret');
  } else {
    await expect(service(PRODUCT_PATHS.cad, { brief, confirmation, images: preview.images.map(image => ({ templateId: image.templateId, dataUrl: image.dataUrl })) }, signal())).rejects.toMatchObject({ code: 'FREECAD_UNAVAILABLE' });
  }
  const fallbackMaterials = await service(PRODUCT_PATHS.materials, { brief, confirmation, figureIds: ['patent-structure'] }, signal()) as ProductMaterials;
  expect(fallbackMaterials.drawings).toContain('图1为本产品的产品结构示意图'); expect(fallbackMaterials.drawings).toContain('A为关键结构');
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, figureIds: ['自定义图'] }, signal())).rejects.toMatchObject({ code: 'FIGURE_LIST_INVALID' });
  const figure = await service(PRODUCT_PATHS.figure, { brief, confirmation, templateId: 'patent-structure' }, signal());
  expect(isProductImage(figure) && figure.prompt.includes(brief.description)).toBe(true);
  expect(calls.filter(call => call.url.includes('/images/'))).toHaveLength(5);
  expect(calls.filter(call => call.url.includes('/images/')).every(call => call.auth === 'Bearer image-test-secret' && call.payload.n === 1 && call.payload.model === productConfig.image!.model)).toBe(true);
  expect(calls.filter(call => call.url.includes('/chat/')).every(call => call.auth === 'Bearer text-test-secret')).toBe(true);
  expect(JSON.stringify({ review, brief, preview, confirmation, figure })).not.toContain('test-secret');
});
test('矛盾未消除、篡改简介、旧预览确认不能跨越后端门禁', async () => {
  let calls = 0;
  const service = createProductWorkflowService(productConfig, async () => { calls++; return jsonEnvelope(logicalResult()); });
  await expect(service(PRODUCT_PATHS.brief, { review: makeReview(productSelection, true) }, signal())).rejects.toMatchObject({ code: 'PRODUCT_CONFLICTS_UNRESOLVED' });
  const brief = makeBrief();
  await expect(service(PRODUCT_PATHS.preview, { brief: { ...brief, createdAt: '2026-10-09T08:01:00.000Z' } }, signal())).rejects.toMatchObject({ code: 'PRODUCT_PROOF_INVALID' });
  const otherPreview = makePreview(makeBrief(makeReview(), 'other-version'));
  await expect(service(PRODUCT_PATHS.confirm, { brief, preview: previewReference(otherPreview), confirmed: true }, signal())).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  await expect(service(PRODUCT_PATHS.confirm, { brief, preview: imageReference(makeImage(brief, 'preview')), confirmed: true }, signal())).rejects.toMatchObject({ code: 'PREVIEW_CONFIRMATION_REQUIRED' });
  const tampered = { ...previewReference(makePreview(brief)), viewIds: ['hero'] };
  await expect(service(PRODUCT_PATHS.confirm, { brief, preview: tampered, confirmed: true }, signal())).rejects.toMatchObject({ code: 'PRODUCT_PROOF_INVALID' });
  const confirmation = makeWorkflow(true).confirmation!;
  await expect(service(PRODUCT_PATHS.materials, { brief: makeBrief(makeReview(), 'another'), confirmation }, signal())).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  await expect(service(PRODUCT_PATHS.cad, { brief: makeBrief(makeReview(), 'another'), confirmation, images: [] }, signal())).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  expect(calls).toBe(0);
});
test('去矛盾请求再次调用文本模型，并使用服务器签名报告中的选择而不是浏览器自填结果', async () => {
  let actual: unknown;
  const service = createProductWorkflowService(productConfig, async (_url, init) => { actual = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).selection; return jsonEnvelope(logicalResult()); });
  const original = makeReview(productSelection, true);
  const result = await service(PRODUCT_PATHS.review, { review: original, resolutions: { 'conflict-1': 'keep-fixed' }, selection: productSelection }, signal()) as ProductReview;
  expect(result.verdict).toBe('feasible'); expect(result.selection.choices).toHaveLength(productSelection.choices.length - 1);
  expect(actual).toEqual(result.selection);
});
test('重画按信息充分性追问，不限制轮数，已足够时直接返回完整选择', async () => {
  let round = 0;
  const service = createProductWorkflowService(productConfig, async () => {
    round++;
    return jsonEnvelope(round < 7 ? { status: 'needs_information', summary: '请决定连接方式', intent: `保留之前的修改意图，当前第${round}轮`, questions: [{ id: 'joint', question: '希望怎样连接？', options: ['保持螺栓连接', '改用卡扣连接'] }] }
      : { status: 'ready', summary: '保留螺栓连接，只调整颜色', intent: '前六轮已明确，主体改为蓝色', changes: { removeIds: [], replacements: [], additions: [] }, visualPreferences: '主体改为蓝色' });
  });
  let dialogue;
  for (let index = 0; index < 7; index++) {
    const result = await service(PRODUCT_PATHS.revise, { brief: makeBrief(), dialogue, input: { text: '调整外观', directions: [], answers: dialogue ? [{ questionId: 'joint', text: '保持螺栓连接' }] : [] } }, signal()) as RevisionResponse;
    if (result.status === 'needs_information') dialogue = result.dialogue;
    else { expect(index).toBe(6); expect(result.selection.visualPreferences).toBe('主体改为蓝色'); expect(result.selection.choices).toEqual(productSelection.choices); }
  }
  expect(round).toBe(7);
});
test('重画回复缺字段或新增特征 id 不合规时自动补齐；格式错误先让模型修正一次，仍错才返回具体原因', async () => {
  const lenient = createProductWorkflowService(productConfig, async () => jsonEnvelope({ status: 'ready', summary: '新增快拆压板', intent: '新增快拆压板',
    changes: { replacements: [], additions: [{ id: 'feature-1', text: '压板改为手拧旋钮快拆结构。' }] } }));
  const result = await lenient(PRODUCT_PATHS.revise, { brief: makeBrief(), input: { text: '改成快拆压板', directions: [], answers: [] } }, signal()) as RevisionResponse;
  expect(result.status).toBe('ready');
  if (result.status === 'ready') {
    expect(result.selection.visualPreferences).toBe('');
    const added = result.selection.choices.at(-1)!;
    expect(added.id).toMatch(/^rev-/); expect(added.category).toBe('结构特征'); expect(result.selection.choices.filter(choice => choice.id === 'feature-1')).toHaveLength(1);
  }
  const prompts: string[] = [];
  const repaired = createProductWorkflowService(productConfig, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); prompts.push(body.messages[0].content);
    return jsonEnvelope(prompts.length === 1 ? { status: 'ready', summary: '', intent: '', changes: { removeIds: ['nope'] } }
      : { status: 'ready', summary: '只改颜色', intent: '只改颜色', changes: { removeIds: [], replacements: [], additions: [] }, visualPreferences: '蓝色' });
  });
  const fixed = await repaired(PRODUCT_PATHS.revise, { brief: makeBrief(), input: { text: '改蓝色', directions: [], answers: [] } }, signal()) as RevisionResponse;
  expect(fixed.status).toBe('ready'); expect(prompts).toHaveLength(2); expect(prompts[1]).toContain('summary 必须'); expect(prompts[1]).toContain('只能引用现有 choice id');
  const stubborn = createProductWorkflowService(productConfig, async () => jsonEnvelope({ status: 'ready', summary: 'x', intent: 'x', changes: { removeIds: ['nope'] } }));
  await expect(stubborn(PRODUCT_PATHS.revise, { brief: makeBrief(), input: { text: '改', directions: [], answers: [] } }, signal())).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT', details: [expect.stringContaining('choice id')] });
});
test('生图异常不假装成功、不自动重试、上游错误不泄露密钥', async () => {
  let calls = 0;
  await expect(generateProductImage(makeBrief(), 'preview', 'color-hero', productConfig, signal(), async () => { calls++; return new Response('private provider message with image-test-secret', { status: 401 }); })).rejects.toMatchObject({ code: 'IMAGE_AUTH' });
  expect(calls).toBe(1);
  await expect(generateProductImage(makeBrief(), 'preview', 'color-hero', productConfig, signal(), async () => new Response(JSON.stringify({ data: [] })))).rejects.toMatchObject({ code: 'IMAGE_EMPTY' });
  await expect(generateProductImage(makeBrief(), 'preview', 'color-hero', productConfig, signal(), async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('<html>not image</html>').toString('base64') }] })))).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
});
test('一个视角失败时其余视角保留，重试只补缺失视角', async () => {
  let attempts = 0;
  const service = createProductWorkflowService(productConfig, async (_url, init) => {
    attempts++;
    const prompt = String(JSON.parse(String(init?.body)).prompt);
    if (attempts <= 4 && prompt.includes('从产品正右方')) return new Response('boom', { status: 500 });
    return imageEnvelope();
  });
  const brief = makeBrief();
  await expect(service(PRODUCT_PATHS.preview, { brief }, signal())).rejects.toMatchObject({ code: 'IMAGE_UPSTREAM', message: expect.stringContaining('3 张视图已生成并保留') });
  expect(attempts).toBe(4);
  const preview = await service(PRODUCT_PATHS.preview, { brief }, signal()) as ProductPreview;
  expect(attempts).toBe(5); expect(preview.images).toHaveLength(4);
});
test('图片下载拒绝本机、私网、IPv6映射、非HTTPS、认证及重定向危险地址', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.5.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1']) expect(isPublicImageAddress(address)).toBe(false);
  expect(isPublicImageAddress('8.8.8.8')).toBe(true);
  for (const url of ['http://cdn.example/image.png', 'https://127.0.0.1/a', 'https://localhost/a', 'https://10.0.0.1/a', 'https://[::ffff:127.0.0.1]/a', 'https://name:secret@cdn.example/a', 'file:///etc/passwd', 'https://cdn.example:9000/a']) expect(() => validateImageUrl(url)).toThrow();
  expect(validateImageUrl('https://cdn.example/image.png').hostname).toBe('cdn.example');
});
test('HTTP 接口维持本机同源门禁、POST/JSON限制，生产路由真正注册', async () => {
  const middleware = createAiMiddleware(productConfig, async () => jsonEnvelope(logicalResult()));
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(base + PRODUCT_PATHS.review, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: productSelection }) });
    expect(response.status).toBe(200); expect(isProductReview(await response.json())).toBe(true);
    const rejected = await fetch(base + PRODUCT_PATHS.review, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    expect(rejected.status).toBe(403);
    expect((await fetch(base + PRODUCT_PATHS.review)).status).toBe(405);
    const proof = signProductArtifact('confirmation', { briefId: 'wrong', previewId: 'wrong', previewDigest: '0'.repeat(64), confirmedAt: '2026-10-09T08:00:00.000Z' }, productConfig);
    const blocked = await fetch(base + PRODUCT_PATHS.materials, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: makeBrief(), confirmation: proof }) });
    expect(blocked.status).toBe(409);
    const cadBlocked = await fetch(base + PRODUCT_PATHS.cad, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: makeBrief(), confirmation: proof, images: [] }) });
    expect(cadBlocked.status).toBe(409);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('服务商分组未开通生图和非生图模型分别返回可操作提示，不泄露上游正文', async () => {
  const group = () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'Image generation is not enabled for this group' } }), { status: 403 }));
  await expect(generateProductImage(makeBrief(), 'preview', 'color-hero', productConfig, signal(), group)).rejects.toMatchObject({ code: 'IMAGE_GROUP_DISABLED', message: expect.stringContaining('分组尚未开启生图') });
  const wrongModel = () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'images endpoint requires an image model, got muse-spark-1.3' } }), { status: 400 }));
  await expect(generateProductImage(makeBrief(), 'preview', 'color-hero', productConfig, signal(), wrongModel)).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED' });
});
test('同一版本的并发预览请求不会重复计费，四个视角各只提交一次，完成后复用缓存', async () => {
  let release!: () => void; let started!: () => void; let calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const called = new Promise<void>(resolve => { started = resolve; });
  const service = createProductWorkflowService(productConfig, async () => { calls++; started(); await pending; return imageEnvelope(); });
  const input = { brief: makeBrief() };
  const first = service(PRODUCT_PATHS.preview, input, signal());
  await called;
  await expect(service(PRODUCT_PATHS.preview, input, signal())).rejects.toMatchObject({ code: 'PRODUCT_REQUEST_RUNNING' });
  release(); const generated = await first;
  expect(await service(PRODUCT_PATHS.preview, input, signal())).toEqual(generated); expect(calls).toBe(4);
});
