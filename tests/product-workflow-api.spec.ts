import { makeTechnicalPlan, makeTextDocument, makeTextBrief, emptyStructureReview, emptyTextReview } from './fixtures/productText';
import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCadCheckpoint, saveCadCheckpoint } from '../server/cadCheckpoint';
import type { AddressInfo } from 'node:net';
import { createProductWorkflowService, PRODUCT_PATHS } from '../server/productWorkflowAi';
import { createAiMiddleware, readAiConfig } from '../server/drawingAi';
import { generateProductImage, isPublicImageAddress, validateImageUrl } from '../server/productImages';
import { applyCadRepair, buildProductCad, preferCadModel, resolveFreeCad } from '../server/productCad';
import { aiProviders, markProviderSucceeded, STRICT_E2E_POLICY } from '../server/aiSupport';
import { signProductArtifact, verifyProductArtifact } from '../server/productProof';
import { applyConflictChoices, imageReference, isProductWorkflow, isProductWorkflowComplete, isLogicResult, isProductDesign, isProductImage, isProductReview, previewReference, PREVIEW_VIEWS } from '../src/features/product/productWorkflow';
import type { ProductReview, ProductBrief, ProductCad, ProductMaterials, ProductPreview, PreviewConfirmation, RevisionResponse } from '../src/features/product/productWorkflow';
import { buildPatentFigurePrompt, buildPreviewPrompt, PATENT_FIGURE_TEMPLATES } from '../src/features/product/productPrompts';
import { imageBytes, jsonEnvelope, logicalResult, makeBrief, makeDesign, makeImage, makePreview, makeReview, makeWorkflow, makeVerifiedCad, productConfig, productSelection, testCadScript, testDrawingPlan } from './fixtures/productWorkflow';

const signal = () => new AbortController().signal;
const imageEnvelope = () => new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }));

test('局部几何替换要求唯一原文，拒绝找不到、重复或整篇脚本替换', () => {
  const decision = { summary: '测试装配', assumptions: [], script: testCadScript, drawingPlan: testDrawingPlan };
  const before = 'Part.makeBox(120, 60, 14', after = 'Part.makeBox(122, 60, 14';
  expect(applyCadRepair({ scriptEdits: [{ before, after }] }, decision, false).decision?.script).toBe(testCadScript.replace(before, after));
  for (const edits of [[{ before: 'not present', after }], [{ before: 'Part.', after }], [{ before, after: before }], [{ before: testCadScript, after: testCadScript + '# changed' }]]) {
    expect(applyCadRepair({ scriptEdits: edits }, decision, false).errors.length).toBeGreaterThan(0);
  }
  expect(applyCadRepair({ script: testCadScript }, decision, false).errors.length).toBeGreaterThan(0);
});

for (const scope of ['drawingPlan', 'geometry'] as const) test(`视觉返修收到真实失败图及完整反馈，按${scope}范围修正`, async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), 'cad-visible-repair-'));
  const config = { ...productConfig, cadCheckpointDir: dir }, brief = makeBrief();
  const decision = { summary: '保留原有装配', assumptions: [], script: testCadScript, drawingPlan: testDrawingPlan };
  const fullFinding = '图2：' + '需要检查的原文要求及可见证据。'.repeat(35) + '最后一条修正要求必须保留';
  let reviews = 0, repairs = 0, failedDigest = '';
  try {
    await saveCadCheckpoint(brief, { decision }, config);
    const cad = await buildProductCad(brief, [], config, signal(), async (_url, init) => {
      const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content;
      const message = request.messages[1].content;
      const input = JSON.parse(typeof message === 'string' ? message : message[0].text);
      if (prompt.includes('独立图文核对员')) {
        reviews++;
        return jsonEnvelope(reviews === 1 ? { passed: false, summary: '测试首次未通过', findings: [fullFinding], repairScope: scope }
          : { passed: true, summary: '测试修正后通过', findings: [] });
      }
      repairs++;
      expect(Array.isArray(message)).toBe(true);
      const images = message.filter((item: {type:string}) => item.type === 'image_url');
      expect(images).toHaveLength(2);
      for (const image of images) expect(image.image_url.url).toMatch(/^data:image\/png;base64,iVBOR/);
      expect(input.imageOrder).toEqual(testDrawingPlan.figures.map((f, i) => `图片${i+1}=图${i+1} ${f.title}`));
      expect(input.repairFindings.current).toEqual([fullFinding]);
      const failed = await readCadCheckpoint(brief, config);
      failedDigest = failed!.rendered!.meshDigest;
      expect(failed?.repairScope).toBe(scope);
      const plan = structuredClone(testDrawingPlan); plan.figures[1].title = '修正后的局部剖视';
      return jsonEnvelope(scope === 'drawingPlan'
        ? { drawingPlan: plan, script: 'import os\n', scriptEdits: [{ before: testCadScript, after: 'invalid' }] }
        : { scriptEdits: [{ before: 'Part.makeBox(120, 60, 14', after: 'Part.makeBox(122, 60, 14' }] });
    });
    expect(repairs).toBe(1); expect(reviews).toBe(2);
    expect(cad.script).toBe(scope === 'drawingPlan' ? testCadScript : testCadScript.replace('Part.makeBox(120, 60, 14', 'Part.makeBox(122, 60, 14'));
    if (scope === 'drawingPlan') expect(cad.meshDigest).toBe(failedDigest);
    else expect(cad.meshDigest).not.toBe(failedDigest);
    expect((await readCadCheckpoint(brief, config))?.findingHistory).toContain(fullFinding);
    expect(cad.visualReview?.status).toBe('passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('标注修正保留已通过实体检查的脚本，并重新执行真实投影与独立核对', async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), 'cad-callout-repair-'));
  const config = { ...productConfig, cadCheckpointDir: dir }, brief = makeBrief();
  const hidden = structuredClone(testDrawingPlan);
  hidden.figures[0].direction = [0, 0, -1]; hidden.figures[0].up = [0, 1, 0];
  let repairs = 0, reviews = 0;
  try {
    const priorFinding = '此前发现：固定齿盘应保留环形限位面。';
    await saveCadCheckpoint(brief, { decision: { summary: '已建立的真实装配', assumptions: [], script: testCadScript, drawingPlan: hidden }, findingHistory: [priorFinding] }, config);
    let repairInput: Record<string, unknown> | undefined;
    const cad = await buildProductCad(brief, [], config, signal(), async (_url, init) => {
      const payload = JSON.parse(String(init?.body)), prompt = payload.messages[0].content;
      if (prompt.includes('独立图文核对员')) {
        reviews++;
        return jsonEnvelope({ passed: true, summary: '测试核对通过', findings: [] });
      }
      repairs++;
      expect(prompt).toContain('本轮只修正附图计划');
      expect(prompt).toContain('完整阅读repairFindings');
      const message = payload.messages[1].content;
      repairInput = JSON.parse(typeof message === 'string' ? message : message[0].text);
      // A repair provider can still emit a script; it must never replace the
      // geometry that passed FreeCAD's solid and contact checks.
      return jsonEnvelope({ drawingPlan: testDrawingPlan, script: 'import os\n' });
    });
    expect(repairs).toBe(1); expect(reviews).toBe(1);
    expect(repairInput?.repairFindings).toMatchObject({ previouslyObserved: [priorFinding] });
    expect((repairInput!.repairFindings as {current:string[]}).current[0]).toContain('图1');
    expect((await readCadCheckpoint(brief, config))?.findingHistory).toContain(priorFinding);
    expect(cad.script).toBe(testCadScript);
    expect(cad.summary).toBe('已建立的真实装配');
    expect(cad.views).toHaveLength(2);
    expect((await readCadCheckpoint(brief, config))?.cad?.id).toBe(cad.id);
    expect(() => verifyProductArtifact('cad', cad, config)).not.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('成功建模的备用模型用于后续图文核对，即使主模型冷却已解除；签名检查点保留选择', async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(join(tmpdir(), 'cad-provider-reuse-'));
  const config = { ...productConfig, baseUrl: 'https://cad-provider-reuse.invalid/v1', fallbackModel: 'cad-rescue', cadCheckpointDir: dir };
  const brief = makeBrief(), calls: { model: string; review: boolean }[] = [];
  let reviewCount = 0, initialScriptCount = 0;
  try {
    const cad = await buildProductCad(brief, [{ templateId: 'color-hero', dataUrl: makePreview(brief).images[0].dataUrl }], config, signal(), async (_url, init) => {
      const request = JSON.parse(String(init?.body)), review = request.messages[0].content.includes('独立图文核对员');
      calls.push({ model: request.model, review });
      if (!review && request.model === productConfig.model) return new Response('{}', { status: 503 });
      if (!review) {
        const user = request.messages[1].content;
        const input = JSON.parse(typeof user === 'string' ? user : user[0].text);
        if (!input.previousOutput && ++initialScriptCount <= 2) return jsonEnvelope({ summary: '测试无效脚本', assumptions: [], script: 'import os\n', drawingPlan: testDrawingPlan });
        // Simulate the main provider becoming eligible again before the next
        // phase; eligibility must not displace this workflow's successful one.
        markProviderSucceeded(aiProviders(config)[0]);
        const plan = structuredClone(testDrawingPlan);
        if (input.previousOutput) plan.figures[1].title = `第${reviewCount}轮修正后的正面结构`;
        return jsonEnvelope(input.previousOutput ? { scriptEdits: [], drawingPlan: plan }
          : { summary: '测试底座、夹持座与螺栓', assumptions: [], script: testCadScript, drawingPlan: plan });
      }
      reviewCount++;
      return jsonEnvelope(reviewCount < 2
        ? { passed: false, summary: '测试模拟需要继续修正。', findings: [`测试问题${reviewCount}：标号表达仍需修正`] }
        : { passed: true, summary: '测试模拟逐图核对通过。', findings: [] });
    });
    expect(calls[0]).toEqual({ model: productConfig.model, review: false });
    expect(calls.slice(1).every(call => call.model === 'cad-rescue')).toBe(true);
    expect(initialScriptCount).toBe(3);
    expect(calls.filter(call => call.review)).toHaveLength(2);
    expect(calls.filter(call => !call.review)).toHaveLength(5);
    expect(cad.generationModel).toBe('cad-rescue');
    expect((await readCadCheckpoint(brief, config))?.generationModel).toBe('cad-rescue');
    expect(preferCadModel(config, 'unconfigured-model')).toBe(config);
    expect(preferCadModel({ ...config, executionPolicy: STRICT_E2E_POLICY }, 'cad-rescue').model).toBe(productConfig.model);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('返修原样返回失败版本时停止，不再次付费核对并保留问题', async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), 'cad-stalled-repair-'));
  const config = { ...productConfig, cadCheckpointDir: dir }, brief = makeBrief();
  const decision = { summary: '等待修正的装配', assumptions: [], script: testCadScript, drawingPlan: testDrawingPlan };
  const issues = ['图2连接位置需要修正。'];
  let calls = 0;
  try {
    await saveCadCheckpoint(brief, { decision, issues }, config);
    await expect(buildProductCad(brief, [], config, signal(), async () => {
      calls++;
      return jsonEnvelope({ scriptEdits: [], summary: '只改了说明和JSON键顺序，实际模型和附图未变',
        drawingPlan: { figures: decision.drawingPlan.figures, anchors: decision.drawingPlan.anchors, version: 1 } });
    })).rejects.toMatchObject({ code: 'CAD_REPAIR_STALLED', details: issues });
    expect(calls).toBe(1);
    const saved = await readCadCheckpoint(brief, config);
    expect(saved?.issues).toEqual(issues);
    expect(saved?.findingHistory).toEqual(issues);
    expect(saved?.cad).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('修正模型连续返回无法应用的结果时重试同一轮，不把整个附图阶段判死', async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(join(tmpdir(), 'cad-repair-output-retry-'));
  const config = { ...productConfig, cadCheckpointDir: dir }, brief = makeBrief();
  const decision = { summary: '等待修正的装配', assumptions: [], script: testCadScript, drawingPlan: testDrawingPlan };
  let repairs = 0, reviews = 0;
  try {
    await saveCadCheckpoint(brief, { decision, issues: ['图2连接位置需要修正。'] }, config);
    const cad = await buildProductCad(brief, [], config, signal(), async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
      if (prompt.includes('独立图文核对员')) { reviews++; return jsonEnvelope({ passed: true, summary: '测试核对通过', findings: [] }); }
      repairs += 1;
      // The first two responses cannot be applied at all (the built-in validation
      // retry is exhausted and chatJson throws AI_INVALID_OUTPUT). The stage must
      // retry the same repair instead of dying on that error.
      return repairs <= 2 ? jsonEnvelope({ scriptEdits: [{ before: '脚本中不存在的片段', after: 'x' }] })
        : jsonEnvelope({ scriptEdits: [{ before: 'Part.makeBox(120, 60, 14', after: 'Part.makeBox(122, 60, 14' }] });
    });
    expect(repairs).toBe(3); expect(reviews).toBe(1);
    expect(cad.script).toContain('Part.makeBox(122, 60, 14');
    expect((await readCadCheckpoint(brief, config))?.cad?.id).toBe(cad.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('实际附图凭据阻止空清单、乱序、错版本、篡改和漏标，重启后仍可复用已签名附图', async () => {
  const w = makeWorkflow(true), brief = w.brief!, confirmation = w.confirmation!, cad = makeVerifiedCad(brief);
  const calls: { url: string; payload: Record<string, unknown>; auth: string | null }[] = [];
  const service = createProductWorkflowService(productConfig, modelFetcher(calls));
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation }, signal())).rejects.toMatchObject({ code: 'DRAWING_PROOF_REQUIRED' });
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, cad, figureIds: ['cad-figure-2', 'cad-figure-1'] }, signal())).rejects.toMatchObject({ code: 'FIGURE_LIST_INVALID' });
  const wrong = structuredClone(cad); wrong.views[0].title = '伪造图名';
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, cad: wrong }, signal())).rejects.toMatchObject({ code: 'PRODUCT_PROOF_INVALID' });
  const { signature: _signature, ...record } = cad;
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, cad: signProductArtifact('cad', { ...record, briefId: 'other' }, productConfig) }, signal())).rejects.toMatchObject({ code: 'DRAWING_STALE' });
  const missing = structuredClone(record); missing.views[0].annotations!.pop();
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, cad: signProductArtifact('cad', missing, productConfig) }, signal())).rejects.toMatchObject({ code: 'DRAWING_INCOMPLETE' });
  expect(calls).toHaveLength(0);
  const materials = await service(PRODUCT_PATHS.materials, { brief, confirmation, cad }, signal()) as ProductMaterials;
  expect(materials.drawings).toContain('图2为本产品的正面结构示意图');
  expect(materials.drawings).not.toContain('图3');
  w.cad = cad; w.materials = materials;
  expect(isProductWorkflowComplete(w)).toBe(true);
  w.cad = { ...cad, views: [...cad.views].reverse() };
  expect(isProductWorkflowComplete(w)).toBe(false);
});
function requestPayload(init?: RequestInit): Record<string, unknown> {
  if (!(init?.body instanceof FormData)) return JSON.parse(String(init?.body || '{}'));
  const payload = Object.fromEntries(init.body.entries());
  return { ...payload, n: Number(payload.n) };
}
for (const responseType of ['application/json', 'application/x-ndjson']) test(`最终图文核对失败后修图，重启继续时复用成功正文并保留有效凭据（${responseType}）`, async () => {
  test.setTimeout(180000);
  expect(await resolveFreeCad(productConfig)).toBeTruthy();
  const dir = await mkdtemp(join(tmpdir(), 'drawing-resume-test-'));
  const config = { ...productConfig, cadCheckpointDir: dir };
  const w = makeWorkflow(true), brief = w.brief!, confirmation = w.confirmation!;
  const calls: { url: string; payload: Record<string, unknown>; auth: string | null }[] = [];
  const baseFetcher = modelFetcher(calls);
  let failFinalOnce = true;
  let repairedReviewDescription = '';
  const fetcher: typeof fetch = async (url, init) => {
    const payload = requestPayload(init), messages = payload.messages as {content: string | {text: string}[]}[];
    const prompt = String(messages?.[0]?.content || '');
    const user = messages?.[1]?.content;
    const input = JSON.parse(typeof user === 'string' ? user : user[0].text);
    if (prompt.includes('CAD 建模助手') && input.previousOutput) {
      const plan=structuredClone(testDrawingPlan);plan.figures[1].title='修复后的正面连接结构';
      return jsonEnvelope({ scriptEdits: [], drawingPlan: plan });
    }
    if (prompt.includes('独立图文核对员') && input.finalDocument && failFinalOnce) {
      failFinalOnce = false;
      return jsonEnvelope({ passed: false, summary: '模拟一次最终核对失败', findings: ['图2连接位置需要修正。'], repairScope: 'drawingPlan' });
    }
    if (prompt.includes('独立图文核对员') && input.finalDocument) repairedReviewDescription=input.finalDocument.drawings;
    return baseFetcher(url, init);
  };
  const images = w.previews!.images.map(i => ({ templateId: i.templateId, dataUrl: i.dataUrl }));
  let middleware = createAiMiddleware(config, fetcher);
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let token: string | undefined;
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'session=final-review-test',
      Accept: responseType, ...(token ? { 'X-Generation-Token': token } : {}) }, body: JSON.stringify(body) });
    const output = await response.text();
    const value = response.headers.get('content-type')?.includes('application/x-ndjson')
      ? output.trim().split('\n').map(line => JSON.parse(line)).find(event => ['result', 'error'].includes(event.type))
      : { data: JSON.parse(output), error: !response.ok ? JSON.parse(output).error : undefined };
    if (value?.error) throw Object.assign(new Error(value.error.message), value.error);
    return value?.data;
  };
  try {
    token = (await post('/api/generation/begin')).token;
    const cad = await post(PRODUCT_PATHS.cad, { brief, confirmation, images }) as ProductCad;
    const priorFinding = '图1之前发现的装配间隙已经修复。';
    await saveCadCheckpoint(brief, { ...(await readCadCheckpoint(brief, config))!, findingHistory: [priorFinding] }, config);
    await expect(post(PRODUCT_PATHS.materials, { brief, confirmation, cad })).rejects.toMatchObject({ code: 'CAD_VISUAL_MISMATCH' });
    expect(await post('/api/generation/heartbeat')).toEqual({ success: true });
    const failed = await readCadCheckpoint(brief, config);
    expect(failed?.pendingMaterials?.textRecord?.status).toBe('completed');
    expect(failed?.cad).toBeUndefined();
    expect(failed?.rendered?.views).toEqual(cad.views);
    expect(failed?.repairScope).toBe('drawingPlan');
    expect(failed?.issues).toEqual(['图2连接位置需要修正。']);
    expect(failed?.findingHistory).toEqual([priorFinding, '图2连接位置需要修正。']);
    const repaired = await post(PRODUCT_PATHS.cad, { brief, confirmation, images }) as ProductCad;
    expect(repaired.id).not.toBe(cad.id);
    expect(repairedReviewDescription).toContain('图2为本产品的修复后的正面连接结构');
    expect((await readCadCheckpoint(brief, config))?.findingHistory).toEqual(failed?.findingHistory);
    const modelCallsBeforeResume = calls.length;
    await post('/api/generation/end');
    token = undefined;
    middleware = createAiMiddleware(config, fetcher);
    token = (await post('/api/generation/begin')).token;
    const materials = await post(PRODUCT_PATHS.materials, { brief, confirmation, cad: repaired }) as ProductMaterials;
    await expect(post('/api/generation/heartbeat')).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
    expect(calls.slice(modelCallsBeforeResume)).toHaveLength(1);
    expect(String((calls.at(-1)!.payload.messages as {content: string}[])[0].content)).toContain('独立图文核对员');
    expect(materials.textRecord).toEqual(failed!.pendingMaterials!.textRecord);
    expect(materials.claims).toEqual(failed!.pendingMaterials!.claims);
    expect(materials.embodiment).toEqual(failed!.pendingMaterials!.embodiment);
    expect((await readCadCheckpoint(brief, config))?.findingHistory).toEqual(failed?.findingHistory);
    expect(() => verifyProductArtifact('materials', materials, config)).not.toThrow();
    expect(isProductWorkflowComplete({ ...w, cad: repaired, materials })).toBe(true);
  } finally {
    if (token) await post('/api/generation/end').catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
function modelFetcher(calls: { url: string; payload: Record<string, unknown>; auth: string | null }[]): typeof fetch {
  return async (url, init) => {
    const payload = requestPayload(init);
    calls.push({ url: String(url), payload, auth: new Headers(init?.headers).get('Authorization') });
    if (String(url).includes('/images/')) return imageEnvelope();
    const prompt = payload.messages[0].content as string;
    const user = payload.messages[1].content;
    const input = JSON.parse(typeof user === 'string' ? user : user[0].text);
    if (prompt.includes('产品方案逻辑审查助手')) return jsonEnvelope(logicalResult());
    if (prompt.includes('围绕选定问题生成一套')) return jsonEnvelope(makeTechnicalPlan(input.selection));
    if (prompt.includes('审查并直接修正输入的结构方案')) return jsonEnvelope(emptyStructureReview());
    if (prompt.includes('对照冻结的plan审查document')) return jsonEnvelope(emptyTextReview());
    if (prompt.includes('独立图文核对员')) return jsonEnvelope({ passed: true, summary: '模拟核对通过', findings: [] });
    if (prompt.includes('CAD 建模助手')) return jsonEnvelope({ summary: '按简介建立底座模型。', assumptions: ['尺寸推定。'], script: testCadScript, drawingPlan: testDrawingPlan });
    return jsonEnvelope(makeTextDocument(input.plan.title));
  };
}

test('图片分析暂时不可用时按冻结结构继续建模，仍完成真实投影和逐图核对', async () => {
  test.setTimeout(120000);
  expect(await resolveFreeCad(productConfig)).toBeTruthy();
  const brief=makeTextBrief(), preview=makePreview(brief);
  const confirmation=signProductArtifact('confirmation',{briefId:brief.id,previewId:preview.id,previewDigest:preview.digest,confirmedAt:new Date().toISOString()},productConfig);
  const calls: { url: string; payload: Record<string, unknown>; auth: string | null }[]=[];
  const base=modelFetcher(calls), cadInputs: unknown[]=[];
  const service=createProductWorkflowService(productConfig,async(url,init)=>{
    const payload=requestPayload(init), messages=payload.messages as {content:string | unknown[]}[];
    if(String(messages?.[0]?.content).includes('CAD 建模助手')) {
      cadInputs.push(messages[1].content);
      if(cadInputs.length===1)return new Response('{}',{status:503});
    }
    return base(url,init);
  });
  const cad=await service(PRODUCT_PATHS.cad,{brief,confirmation,images:preview.images.map(i=>({templateId:i.templateId,dataUrl:i.dataUrl}))},signal()) as ProductCad;
  expect(cadInputs).toHaveLength(2);
  expect(Array.isArray(cadInputs[0])).toBe(true);
  expect(typeof cadInputs[1]).toBe('string');
  expect(JSON.parse(cadInputs[1] as string).technicalPlan).toEqual(brief.technicalSource!.plan);
  expect(cad.views).toHaveLength(2);
  expect(cad.visualReview?.status).toBe('passed');
});
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
test('独立文本与生图密钥只在服务器配置，先生成主体图再上传参考图生成三视图，确认后走 FreeCAD 附图与文案', async () => {
  const settings = readAiConfig({ AI_BASE_URL: productConfig.baseUrl, AI_API_KEY: productConfig.apiKey, AI_MODEL: productConfig.model,
    AI_IMAGE_BASE_URL: productConfig.image!.baseUrl, AI_IMAGE_API_KEY: productConfig.image!.apiKey, AI_IMAGE_MODEL: productConfig.image!.model });
  settings.cadCheckpointDir = false;
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
  expect(calls.filter(call => call.url.endsWith('/images/generations'))).toHaveLength(1);
  const edits = calls.filter(call => call.url.endsWith('/images/edits'));
  expect(edits).toHaveLength(3);
  for (const edit of edits) {
    const image = edit.payload.image as File;
    expect(image.type).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(preview.images[0].dataUrl.split(',')[1], 'base64'));
    expect(edit.payload.prompt).toContain('上传的图片是本产品已生成的主体图');
  }
  const sentPrompts = calls.filter(call => call.url.includes('/images/')).map(call => String(call.payload.prompt));
  expect(new Set(sentPrompts).size).toBe(4); expect(sentPrompts.every(prompt => prompt.includes(brief.description))).toBe(true);
  await expect(service(PRODUCT_PATHS.figure, { brief, templateId: 'patent-structure' }, signal())).rejects.toMatchObject({ code: 'PREVIEW_CONFIRMATION_REQUIRED' });
  await expect(service(PRODUCT_PATHS.cad, { brief, images: [] }, signal())).rejects.toMatchObject({ code: 'PREVIEW_CONFIRMATION_REQUIRED' });
  const confirmation = await service(PRODUCT_PATHS.confirm, { brief, preview: previewReference(preview), confirmed: true }, signal()) as PreviewConfirmation;
  expect(confirmation.previewDigest).toBe(preview.digest);
  const freecad = await resolveFreeCad(settings);
  if (freecad) {
    const images = preview.images.map(image => ({ templateId: image.templateId, dataUrl: image.dataUrl }));
    const cad = await service(PRODUCT_PATHS.cad, { brief, confirmation, images }, signal()) as ProductCad;
    expect(cad.briefId).toBe(brief.id); expect(cad.views.map(view => view.title)).toEqual(['整体结构示意图', '正面结构示意图']); expect(cad.script).toBe(testCadScript);
    expect(cad.views.every(view => view.svg.startsWith('<svg') && view.svg.includes('<path'))).toBe(true);
    // 标号来自网格的部件归属：每个视角只标可见部件，A 圈选只出现在立体图；标号记录与简介部件一一对应。
    expect(cad.views.find(view => view.view === 'figure-1')!.svg).toContain('>1<'); expect(cad.views.find(view => view.view === 'figure-1')!.svg).toContain('>2<');
    expect(cad.views.filter(view => view.svg.includes('<circle')).map(view => view.view)).toEqual([]);
    expect(cad.labels.map(label => `${label.number} ${label.name}`)).toEqual(['1 轨道底座', '2 夹持座', '3 锁紧螺栓']);
    const vision = calls.find(call => String(call.payload.messages?.[0]?.content).includes('CAD 建模助手'))!;
    expect((vision.payload.messages as { content: unknown }[])[1].content).toHaveLength(5);
    const materials = await service(PRODUCT_PATHS.materials, { brief, confirmation }, signal()) as ProductMaterials;
    expect(materials.drawings).toContain('图1为本产品的整体结构示意图'); expect(materials.drawings).toContain('图2为本产品的正面结构示意图'); expect(materials.drawings).not.toContain('A为关键结构');
    expect(JSON.stringify(cad)).not.toContain('test-secret');
  } else {
    await expect(service(PRODUCT_PATHS.cad, { brief, confirmation, images: preview.images.map(image => ({ templateId: image.templateId, dataUrl: image.dataUrl })) }, signal())).rejects.toMatchObject({ code: 'FREECAD_UNAVAILABLE' });
  }
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, figureIds: ['patent-structure'] }, signal())).rejects.toMatchObject({ code: freecad ? 'FIGURE_LIST_INVALID' : 'DRAWING_PROOF_REQUIRED' });
  await expect(service(PRODUCT_PATHS.materials, { brief, confirmation, figureIds: ['自定义图'] }, signal())).rejects.toMatchObject({ code: freecad ? 'FIGURE_LIST_INVALID' : 'DRAWING_PROOF_REQUIRED' });
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
  const repairInputs: any[] = [];
  const repaired = createProductWorkflowService(productConfig, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); prompts.push(body.messages[0].content); repairInputs.push(JSON.parse(body.messages[1].content));
    return jsonEnvelope(prompts.length === 1 ? { status: 'ready', summary: '', intent: '', changes: { removeIds: ['nope'] } }
      : { status: 'ready', summary: '只改颜色', intent: '只改颜色', changes: { removeIds: [], replacements: [], additions: [] }, visualPreferences: '蓝色' });
  });
  const fixed = await repaired(PRODUCT_PATHS.revise, { brief: makeBrief(), input: { text: '改蓝色', directions: [], answers: [] } }, signal()) as RevisionResponse;
  expect(fixed.status).toBe('ready'); expect(prompts).toHaveLength(2);
  expect(repairInputs[1].correction.errors.join('；')).toContain('summary 必须');
  expect(repairInputs[1].correction.errors.join('；')).toContain('只能引用现有 choice id');
  expect(repairInputs[1].correction.previousOutput.summary).toBe('');
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
    const prompt = String(requestPayload(init).prompt);
    if (attempts <= 4 && prompt.includes('从产品正右方')) return new Response('boom', { status: 500 });
    return imageEnvelope();
  });
  const brief = makeBrief();
  await expect(service(PRODUCT_PATHS.preview, { brief }, signal())).rejects.toMatchObject({ code: 'IMAGE_REFERENCE_UPSTREAM', message: expect.stringContaining('3 张视图已生成并保留') });
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
test('主体图完成前不提交三视图，之后依次上传同一主体图，并发请求及完成后重试不重复计费', async () => {
  let releaseHero!: () => void; let started!: () => void; let releaseFirstView!: () => void; let firstViewStarted!: () => void; let secondViewStarted!: () => void;
  const heroPending = new Promise<void>(resolve => { releaseHero = resolve; });
  const called = new Promise<void>(resolve => { started = resolve; });
  const firstViewPending = new Promise<void>(resolve => { releaseFirstView = resolve; });
  const firstView = new Promise<void>(resolve => { firstViewStarted = resolve; });
  const secondView = new Promise<void>(resolve => { secondViewStarted = resolve; });
  const calls: { url: string; body: RequestInit['body'] }[] = [];
  let activeViews = 0; let peakActiveViews = 0;
  const service = createProductWorkflowService(productConfig, async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).endsWith('/generations')) { started(); await heroPending; }
    else {
      expect(init?.body).toBeInstanceOf(FormData);
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
      activeViews++;
      peakActiveViews = Math.max(peakActiveViews, activeViews);
      expect(activeViews).toBe(1);
      const viewCalls = calls.filter(call => call.url.endsWith('/edits')).length;
      if (viewCalls === 1) { firstViewStarted(); await firstViewPending; }
      if (viewCalls === 2) secondViewStarted();
      activeViews--;
    }
    return imageEnvelope();
  });
  const input = { brief: makeBrief() };
  const first = service(PRODUCT_PATHS.preview, input, signal());
  await called;
  expect(calls.map(call => call.url)).toEqual([`${productConfig.image!.baseUrl}/images/generations`]);
  await expect(service(PRODUCT_PATHS.preview, input, signal())).rejects.toMatchObject({ code: 'PRODUCT_REQUEST_RUNNING' });
  releaseHero(); await firstView;
  expect(calls).toHaveLength(2);
  releaseFirstView(); await secondView;
  expect(calls).toHaveLength(3);
  const generated = await first;
  expect(peakActiveViews).toBe(1);
  expect(await service(PRODUCT_PATHS.preview, input, signal())).toEqual(generated); expect(calls).toHaveLength(4);
});

test('不同项目的生图请求共享上游名额，排队中的请求可取消', async () => {
  let releaseFirstImage!: () => void; let firstImageStarted!: () => void; let secondImageStarted!: () => void;
  const firstImagePending = new Promise<void>(resolve => { releaseFirstImage = resolve; });
  const firstStarted = new Promise<void>(resolve => { firstImageStarted = resolve; });
  const secondStarted = new Promise<void>(resolve => { secondImageStarted = resolve; });
  let active = 0; let peak = 0; let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      if (calls === 1) { firstImageStarted(); await firstImagePending; }
      if (calls === 2) secondImageStarted();
      return imageEnvelope();
    } finally { active--; }
  };

  const firstBrief = makeBrief();
  const secondBrief = makeBrief(makeReview(), 'brief-2');
  const first = generateProductImage(firstBrief, 'preview', 'color-hero', productConfig, signal(), fetcher);
  await firstStarted;
  const cancelledController = new AbortController();
  const cancelled = generateProductImage(secondBrief, 'preview', 'color-hero', productConfig, cancelledController.signal, fetcher);
  cancelledController.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  expect(calls).toBe(1);
  const second = generateProductImage(secondBrief, 'preview', 'color-hero', productConfig, signal(), fetcher);
  releaseFirstImage();
  await secondStarted;
  await Promise.all([first, second]);
  expect(peak).toBe(1);
  expect(calls).toBe(2);
});

test('主体图失败或生成期间取消时不提交三视图，重试从主体图继续', async () => {
  const calls: string[] = [];
  const service = createProductWorkflowService(productConfig, async url => {
    calls.push(String(url));
    return calls.length === 1 ? new Response('failed', { status: 500 }) : imageEnvelope();
  });
  const input = { brief: makeBrief() };
  await expect(service(PRODUCT_PATHS.preview, input, signal())).rejects.toMatchObject({ code: 'IMAGE_UPSTREAM' });
  expect(calls).toHaveLength(1);
  const preview = await service(PRODUCT_PATHS.preview, input, signal()) as ProductPreview;
  expect(preview.images).toHaveLength(4);
  expect(calls.filter(url => url.endsWith('/generations'))).toHaveLength(2);
  expect(calls.filter(url => url.endsWith('/edits'))).toHaveLength(3);

  const controller = new AbortController();
  const cancelledCalls: string[] = [];
  const cancelled = createProductWorkflowService(productConfig, async url => {
    cancelledCalls.push(String(url)); controller.abort(); return imageEnvelope();
  });
  await expect(cancelled(PRODUCT_PATHS.preview, input, controller.signal)).rejects.toBeTruthy();
  expect(cancelledCalls).toHaveLength(1);
});

test('三视图缺少同版本主体参考图或参考图内容被修改时不向上游提交请求', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return imageEnvelope(); };
  const brief = makeBrief();
  await expect(generateProductImage(brief, 'preview', 'color-front', productConfig, signal(), fetcher)).rejects.toMatchObject({ code: 'PREVIEW_REFERENCE_REQUIRED' });
  await expect(generateProductImage(brief, 'preview', 'color-top', productConfig, signal(), fetcher, makeImage(makeBrief(makeReview(), 'other-brief')))).rejects.toMatchObject({ code: 'PREVIEW_REFERENCE_REQUIRED' });
  await expect(generateProductImage(brief, 'preview', 'color-right', productConfig, signal(), fetcher, { ...makeImage(brief), digest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PREVIEW_REFERENCE_INVALID' });
  expect(calls).toBe(0);
});

test('服务商不支持参考图时保留主体图，不降级文字生图，重试复用主体图', async () => {
  const calls: string[] = [];
  const service = createProductWorkflowService(productConfig, async url => {
    calls.push(String(url));
    return String(url).endsWith('/edits') ? new Response('private image-test-secret', { status: 404 }) : imageEnvelope();
  });
  const input = { brief: makeBrief() };
  await expect(service(PRODUCT_PATHS.preview, input, signal())).rejects.toMatchObject({ code: 'IMAGE_REFERENCE_UPSTREAM', message: expect.stringContaining('1 张视图已生成并保留') });
  await expect(service(PRODUCT_PATHS.preview, input, signal())).rejects.toMatchObject({ code: 'IMAGE_REFERENCE_UPSTREAM', message: expect.stringContaining('images/edits') });
  expect(calls.filter(url => url.endsWith('/generations'))).toHaveLength(1);
  expect(calls.filter(url => url.endsWith('/edits'))).toHaveLength(6);
});
