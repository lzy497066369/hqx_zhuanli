// Opt-in only. Uses real paid providers once per missing stage; caches progress on disk for safe resumption.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readAiConfig } from '../../server/drawingAi.ts';
import { createProductWorkflowService, PRODUCT_PATHS } from '../../server/productWorkflowAi.ts';
import { isProductWorkflowComplete, previewReference } from '../../src/features/product/productWorkflow.ts';
if (process.env.RUN_PRODUCT_LIVE !== '1') throw new Error('Set RUN_PRODUCT_LIVE=1 explicitly to enable paid provider calls.');
const root = path.resolve(process.env.PRODUCT_LIVE_OUTPUT || 'artifacts/product-workflow-2026-10-09');
const workspace = process.cwd();
if (root !== workspace && !root.startsWith(workspace + path.sep)) throw new Error('Live test output must remain inside this workspace.');
await fs.mkdir(root, { recursive: true });
const file = path.join(root, 'live-workflow.json');
const config = readAiConfig(process.env);
let requests;
try { requests = JSON.parse(await fs.readFile(path.join(root, 'live-request-summary.json'), 'utf8')); } catch { requests = []; }
if (!Array.isArray(requests)) requests = [];
const initialRequestCount = requests.length;
const fetcher = async (url, init) => {
  const payload = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init?.body || '{}');
  const entry = { kind: String(url).includes('/images/') ? 'image' : 'text', model: payload.model, startedAt: new Date().toISOString() };
  requests.push(entry);
  const response = await fetch(url, init); entry.status = response.status;
  return response;
};
const directService = createProductWorkflowService(config, fetcher);
const localBase = process.env.PRODUCT_LIVE_BASE_URL ? new URL(process.env.PRODUCT_LIVE_BASE_URL) : undefined;
if (localBase && (localBase.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(localBase.hostname) || localBase.username || localBase.password)) throw new Error('The live-test server must be a local HTTP application.');
const service = !localBase ? directService : async (route, body, signal, onProgress) => {
  const entry = { kind: 'local-api', stage: route.split('/').at(-1), startedAt: new Date().toISOString() };
  requests.push(entry);
  const response = await fetch(new URL(route, localBase), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body), signal });
  entry.status = response.status;
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Local API request failed'), { code: result.error?.code });
    return result;
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') onProgress?.(event.step.label, event.step.detail);
    if (event.type === 'error') throw Object.assign(new Error(event.error.message), { code: event.error.code });
    if (event.type === 'result') result = event.data;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) break;
    }
    consume(buffer);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (result === undefined) throw new Error('Local API closed without returning a complete result.');
  entry.completedAt = new Date().toISOString();
  return result;
};
const selection = {
  company: '流程验证示例设备有限公司', business: '光伏组件安装支架', product: '光伏组件安装支架',
  proposedName: '一种具有滑槽锁紧连接结构的光伏组件安装支架', patentType: 'utility', improvementType: 'structure', visualPreferences: '',
  choices: [
    { id: 'feature-1', category: '结构特征', text: '底座通过螺栓固定于安装面，两个平行支承轨道在底座上固定。' },
    { id: 'feature-2', category: '结构特征', text: '夹持座通过T形滑槽沿轨道滑动调节安装位置，调好后由锁紧螺栓固定；调节状态与锁定状态分开。' },
    { id: 'feature-3', category: '结构特征', text: '压板通过紧固螺栓将光伏组件边框压在夹持座支承面上，压板边缘设防脱挡边。' },
    { id: 'feature-4', category: '使用环境', text: '用于常规室外支架安装；承载、风载、耐腐蚀、螺栓规格等需要工程核实，不作保证。' },
  ],
};
let state;
try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
catch { state = { version: 2, sourceFingerprint: 'live-product-smoke-only', selection, figures: {}, redrawCount: 0, updatedAt: new Date().toISOString() }; }
const save = async () => { state.updatedAt = new Date().toISOString(); await fs.writeFile(file, JSON.stringify(state, null, 2)); await fs.writeFile(path.join(root, 'live-request-summary.json'), JSON.stringify(requests, null, 2)); };
const signal = AbortSignal.timeout(900000);
const progress = (label, detail) => console.log(`${label}: ${detail}`);
try {
  if (!state.review) { state.review = await service(PRODUCT_PATHS.review, { selection: state.selection }, signal, progress); state.selection = state.review.selection; await save(); }
  if (state.review.verdict !== 'feasible') throw new Error('LIVE_CONFLICTS: requires an explicit resolution; see the saved report.');
  if (!state.brief) { state.brief = await service(PRODUCT_PATHS.brief, { review: state.review }, signal, progress); await save(); }
  if (!state.previews) { state.previews = await service(PRODUCT_PATHS.preview, { brief: state.brief }, signal, progress); await save(); }
  for (const image of state.previews.images) await fs.writeFile(path.join(root, `live-color-${image.templateId}.` + (image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/jpeg' ? 'jpg' : 'webp')), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
  if (process.env.PRODUCT_LIVE_STOP_AFTER === 'preview') {
    console.log(JSON.stringify({ stage: 'preview', complete: false, requestCountThisRun: requests.length - initialRequestCount, resultDirectory: root }));
  } else {
  if (!state.confirmation && process.env.PRODUCT_LIVE_REQUIRE_CONFIRM === '1' && process.env.PRODUCT_LIVE_ALLOW_CONFIRM !== '1') throw new Error('Preview saved. Inspect it and explicitly allow this synthetic test confirmation before continuing.');
  if (!state.confirmation) { state.confirmation = await service(PRODUCT_PATHS.confirm, { brief: state.brief, preview: previewReference(state.previews), confirmed: true }, signal); await save(); }
  // 先出 FreeCAD 统一模型与附图，再按实际附图清单生成文案；FreeCAD 不可用时改用 AI 黑白结构图。
  if (!state.cad && !state.figures['patent-structure']) {
    try { state.cad = await service(PRODUCT_PATHS.cad, { brief: state.brief, confirmation: state.confirmation, images: state.previews.images.map(image => ({ templateId: image.templateId, dataUrl: image.dataUrl })) }, signal, progress); await save(); }
    catch (error) { if (error.code !== 'FREECAD_UNAVAILABLE') throw error; console.warn('FreeCAD unavailable; falling back to the AI structure figure.'); }
  }
  if (!state.cad && !state.figures['patent-structure']) { state.figures['patent-structure'] = await service(PRODUCT_PATHS.figure, { brief: state.brief, confirmation: state.confirmation, templateId: 'patent-structure' }, signal, progress); await save(); }
  const figureIds = state.cad ? state.cad.views.map(view => `cad-${view.view}`) : ['patent-structure'];
  if (!state.materials) { state.materials = await service(PRODUCT_PATHS.materials, { brief: state.brief, confirmation: state.confirmation, figureIds }, signal, progress); await save(); }
  if (state.cad) for (const view of state.cad.views) await fs.writeFile(path.join(root, `live-cad-${view.view}.svg`), view.svg);
  const figure = state.figures['patent-structure'];
  if (figure) await fs.writeFile(path.join(root, 'live-patent-structure.' + (figure.mimeType === 'image/png' ? 'png' : figure.mimeType === 'image/jpeg' ? 'jpg' : 'webp')), Buffer.from(figure.dataUrl.split(',')[1], 'base64'));
  console.log(JSON.stringify({ complete: isProductWorkflowComplete(state), figureSource: state.cad ? 'freecad' : 'ai-image', requestCountThisRun: requests.length - initialRequestCount, resultDirectory: root }));
  }
} catch (error) {
  await save();
  console.error(JSON.stringify({ failed: true, code: error.code || error.name, message: error.message, requestCountThisRun: requests.length - initialRequestCount, progressSaved: true }));
  process.exitCode = 1;
}
