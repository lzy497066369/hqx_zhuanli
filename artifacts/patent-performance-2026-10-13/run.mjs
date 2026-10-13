import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readAiConfig } from '../../server/drawingAi.ts';
import { createProductWorkflowService, PRODUCT_PATHS } from '../../server/productWorkflowAi.ts';
import { previewReference, isProductWorkflowComplete } from '../../src/features/product/productWorkflow.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = readAiConfig(process.env);
const report = { startedAt: new Date().toISOString(), scope: 'Fresh synthetic solar mounting bracket, production service functions and browser compression/export; no API queue or database', models: { text: config.model, image: config.image?.model, vision: config.vision?.model || config.model }, stages: [], requests: [], progress: [], network: [] };
let stageName = '', state;
const saveReport = () => fs.writeFile(path.join(root, 'timings.json'), JSON.stringify(report, null, 2));
const saveState = () => fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state));
const ms = start => Math.round(performance.now() - start);
async function stage(name, fn) {
  stageName = name;
  const started = performance.now();
  const record = { name, startedAt: new Date().toISOString(), outcome: 'running' };
  report.stages.push(record); await saveReport();
  console.log('START', name);
  try { const result = await fn(); record.outcome = 'completed'; return result; }
  catch (error) { record.outcome = 'failed'; record.error = { code: error.code || error.name, message: error.message, details: error.details }; throw error; }
  finally { record.elapsedMs = ms(started); record.completedAt = new Date().toISOString(); await saveReport(); console.log('END', name, record.elapsedMs, record.outcome); }
}
const fetcher = async (url, init) => {
  const payload = JSON.parse(init.body);
  const started = performance.now();
  const record = { id: report.requests.length + 1, stage: stageName, host: new URL(url).hostname, endpoint: new URL(url).pathname, model: payload.model, stream: payload.stream, maxTokens: payload.max_completion_tokens, requestBytes: Buffer.byteLength(init.body), systemChars: payload.messages?.[0]?.content?.length, userChars: typeof payload.messages?.[1]?.content === 'string' ? payload.messages[1].content.length : payload.messages?.[1]?.content?.[0]?.text?.length, startedAt: new Date().toISOString(), contentChars: 0, bytes: 0, contentChunks: 0, maxContentGapMs: 0 };
  report.requests.push(record); await saveReport();
  let pending = '', lastContent, raw = '', endSeen = false;
  const decoder = new TextDecoder();
  const parse = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
    try {
      const event = JSON.parse(data); const choice = event.choices?.[0];
      if (event.usage) record.usage = event.usage;
      if (choice?.finish_reason) record.finishReason = choice.finish_reason;
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text.length) {
        const now = ms(started); record.firstContentMs ??= now;
        if (lastContent !== undefined) record.maxContentGapMs = Math.max(record.maxContentGapMs, now - lastContent);
        lastContent = now; record.lastContentMs = now; record.contentChunks++; record.contentChars += text.length;
      }
    } catch { record.parseErrors = (record.parseErrors || 0) + 1; }
  };
  try {
    const response = await fetch(url, init);
    record.headersMs = ms(started); record.status = response.status; record.contentType = response.headers.get('content-type');
    const sse = record.contentType?.includes('text/event-stream');
    const body = response.body?.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        record.firstByteMs ??= ms(started); record.bytes += chunk.byteLength;
        if (sse) { pending += decoder.decode(chunk, { stream: true }); const lines = pending.split(/\r?\n/); pending = lines.pop(); lines.forEach(parse); }
        else if (payload.messages && raw.length < 256000) raw += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
      async flush() {
        if (sse && pending.trim()) parse(pending);
        else if (payload.messages) { try { const event = JSON.parse(raw); record.usage = event.usage; record.contentChars = event.choices?.[0]?.message?.content?.length || 0; record.finishReason = event.choices?.[0]?.finish_reason; } catch {} }
        record.totalMs = ms(started); endSeen = true; await saveReport();
        console.log('REQUEST', record.id, record.stage, record.model, record.status, record.totalMs, 'firstContent', record.firstContentMs, 'chars', record.contentChars);
      }
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    record.totalMs = ms(started); record.error = { name: error.name, code: error.cause?.code }; await saveReport(); throw error;
  }
};
const progress = (label, detail) => { report.progress.push({ stage: stageName, at: new Date().toISOString(), label, detail }); console.log('PROGRESS', stageName, label); };
const service = createProductWorkflowService(config, fetcher);
async function probe(baseUrl) {
  const url = new URL(baseUrl); const start = performance.now();
  const record = { host: url.hostname, method: 'HEAD', path: url.pathname };
  report.network.push(record);
  await new Promise(resolve => {
    const request = https.request(url, { method: 'HEAD', timeout: 10000 }, response => { record.headersMs = ms(start); record.status = response.statusCode; response.resume(); response.on('end', resolve); });
    request.on('socket', socket => { socket.on('lookup', () => { record.dnsMs = ms(start); }); socket.on('connect', () => { record.tcpMs = ms(start); }); socket.on('secureConnect', () => { record.tlsMs = ms(start); }); });
    request.on('timeout', () => request.destroy(new Error('probe_timeout')));
    request.on('error', error => { record.error = error.cause?.code || error.code || error.name; resolve(); }); request.end();
  }); record.totalMs = ms(start); await saveReport();
}

await fs.mkdir(root, { recursive: true });
const old = JSON.parse(await fs.readFile('artifacts/product-workflow-2026-10-10/live-workflow.json', 'utf8'));
try { state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')); }
catch { state = { version: 2, sourceFingerprint: 'performance-synthetic-only', selection: old.selection, figures: {}, redrawCount: 0, updatedAt: new Date().toISOString() }; }
const vite = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage();
await page.goto(vite.resolvedUrls.local[0]);
const signal = AbortSignal.timeout(2400000);
try {
  for (const base of new Set([config.baseUrl, config.image?.baseUrl].filter(Boolean))) for (let i = 0; i < 3; i++) await probe(base);
  if (!state.review) { state.review = await stage('review', () => service(PRODUCT_PATHS.review, { selection: state.selection }, signal, progress)); state.selection = state.review.selection; await saveState(); }
  if (state.review.verdict !== 'feasible') throw new Error('Synthetic selection has conflicts; see state.json');
  if (!state.brief) { state.brief = await stage('brief', () => service(PRODUCT_PATHS.brief, { review: state.review }, signal, progress)); await saveState(); }
  if (!state.previews) { state.previews = await stage('preview', () => service(PRODUCT_PATHS.preview, { brief: state.brief }, signal, progress)); await saveState(); }
  for (const image of state.previews.images) await fs.writeFile(path.join(root, `${image.templateId}.png`), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
  if (!state.confirmation) { state.confirmation = await stage('confirm', () => service(PRODUCT_PATHS.confirm, { brief: state.brief, preview: previewReference(state.previews), confirmed: true }, signal, progress)); await saveState(); }
  if (!state.cad) {
    const images = await stage('browser-image-compression', () => page.evaluate(async preview => { const mod = await import('/src/features/product/productWordExport.ts'); return mod.previewImagesForVision(preview); }, state.previews));
    state.cad = await stage('cad', () => service(PRODUCT_PATHS.cad, { brief: state.brief, confirmation: state.confirmation, images }, signal, progress)); await saveState();
  }
  for (const view of state.cad.views) await fs.writeFile(path.join(root, `cad-${view.view}.svg`), view.svg);
  if (!state.materials) { state.materials = await stage('materials', () => service(PRODUCT_PATHS.materials, { brief: state.brief, confirmation: state.confirmation, figureIds: state.cad.views.map(v => `cad-${v.view}`) }, signal, progress)); await saveState(); }
  const bytes = await stage('word-export', () => page.evaluate(async workflow => { const mod = await import('/src/features/product/productWordExport.ts'); const blob = await mod.createProductWordBlob(workflow); return Array.from(new Uint8Array(await blob.arrayBuffer())); }, state));
  await fs.writeFile(path.join(root, 'sample-patent.docx'), Buffer.from(bytes));
  report.complete = isProductWorkflowComplete(state); report.cad = { vertices: state.cad.vertexCount, triangles: state.cad.triangleCount, version: state.cad.freecadVersion }; report.documentBytes = bytes.length;
} catch (error) { report.error = { code: error.code || error.name, message: error.message, details: error.details }; console.error('FAILED', JSON.stringify(report.error)); process.exitCode = 1; }
finally { report.completedAt = new Date().toISOString(); await saveReport(); await saveState(); await browser.close(); await vite.close(); }
console.log('SUMMARY', JSON.stringify({ complete: report.complete, stages: report.stages.map(({name, elapsedMs, outcome}) => ({name, elapsedMs, outcome})), error: report.error }));
