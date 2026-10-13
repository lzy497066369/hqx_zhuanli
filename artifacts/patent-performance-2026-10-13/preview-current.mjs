import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readAiConfig } from '../../server/drawingAi.ts';
import { createProductWorkflowService, PRODUCT_PATHS } from '../../server/productWorkflowAi.ts';
const root = 'artifacts/patent-performance-2026-10-13';
const config = readAiConfig(process.env);
const state = JSON.parse(await fs.readFile(`${root}/state.json`, 'utf8'));
const report = { startedAt: new Date().toISOString(), requests: [], progress: [], sourceHashes: {} };
for (const file of ['server/productWorkflowAi.ts', 'server/productImages.ts', 'src/features/product/productPrompts.ts']) report.sourceHashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
const start = performance.now();
const elapsed = () => Math.round(performance.now() - start);
const save = () => fs.writeFile(`${root}/preview-current-timings.json`, JSON.stringify(report, null, 2));
const fetcher = async (url, init) => {
  const requestStart = elapsed();
  const form = init.body instanceof FormData;
  const payload = form ? Object.fromEntries([...init.body].filter(([,value]) => typeof value === 'string')) : JSON.parse(init.body);
  const record = { id: report.requests.length + 1, endpoint: new URL(url).pathname, model: payload.model, promptChars: payload.prompt?.length, referenceBytes: form ? [...init.body].reduce((n,[,v]) => n + (typeof v === 'string' ? 0 : v.size), 0) : 0, startedMs: requestStart };
  report.requests.push(record); await save();
  try {
    const response = await fetch(url, init); record.status = response.status; record.headersMs = elapsed() - requestStart;
    return new Response(response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) { record.bytes = (record.bytes || 0) + chunk.byteLength; controller.enqueue(chunk); }, async flush() { record.totalMs = elapsed() - requestStart; await save(); console.log('REQUEST', JSON.stringify(record)); } })), { status: response.status, headers: response.headers });
  } catch (error) { record.elapsedMs = elapsed() - requestStart; record.error = { name: error.name, code: error.cause?.code }; throw error; }
};
try {
  const service = createProductWorkflowService(config, fetcher);
  const previews = await service(PRODUCT_PATHS.preview, { brief: state.brief }, AbortSignal.timeout(600000), (label, detail) => { report.progress.push({ atMs: elapsed(), label, detail }); console.log('PROGRESS', label); });
  await fs.writeFile(`${root}/preview-current.json`, JSON.stringify(previews));
  for (const image of previews.images) await fs.writeFile(`${root}/current-${image.templateId}.png`, Buffer.from(image.dataUrl.split(',')[1], 'base64'));
  report.complete = true;
} catch (error) { report.error = { code: error.code || error.name, message: error.message, details: error.details }; console.error('FAILED', JSON.stringify(report.error)); process.exitCode = 1; }
finally { report.elapsedMs = elapsed(); report.completedAt = new Date().toISOString(); await save(); }
console.log('SUMMARY', JSON.stringify(report));
