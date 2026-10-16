// Opt-in live regression: fresh model through the same HTTP CAD route as the UI.
// Existing real text/previews are input; no seeded decision or manual model edit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { createAiMiddleware, readAiConfig } from '../../server/drawingAi.ts';
import { previewReference } from '../../src/features/product/productWorkflow.ts';
import { drawingCoverageErrors, drawingDescription } from '../../src/features/product/productDrawing.ts';
import { reviewCadDrawings } from '../../server/cadVisualReview.ts';
import { preferCadModel, visionConfig } from '../../server/productCad.ts';
import { signProductArtifact, verifyProductArtifact } from '../../server/productProof.ts';
import { PREVIEW_VIEWS } from '../../src/features/product/productPrompts.ts';

if (process.env.RUN_PATENT_DRAWING_LIVE !== '1') throw new Error('Live acceptance opt-in required');
const root = path.resolve(process.env.DRAWING_LIVE_OUTPUT || 'artifacts/patent-timeout-2026-10-14/fresh-clamp');
const sourcePath = process.env.DRAWING_LIVE_SOURCE || 'artifacts/patent-drawing-2026-10-14/complex-clamp/source-with-vision-images.json';
const sourceBytes = await fs.readFile(sourcePath), source = JSON.parse(sourceBytes);
await fs.mkdir(root, { recursive: true });
const config = { ...readAiConfig(process.env), cadCheckpointDir: path.join(root, 'checkpoints') };
const resume = process.env.DRAWING_LIVE_RESUME === '1';
if (!resume && (await fs.readdir(config.cadCheckpointDir).catch(() => [])).length) throw new Error('Fresh acceptance requires an empty checkpoint directory');
const requests = [], events = [], stages = [], started = Date.now();
let writes = Promise.resolve();
const saveRequests = () => { writes = writes.then(() => fs.writeFile(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2))); };
const fetcher = async (url, init) => {
  const payload = JSON.parse(init.body), began = Date.now();
  const entry = { index: requests.length, model: payload.model, imageCount: Array.isArray(payload.messages?.[1]?.content) ? payload.messages[1].content.filter(c => c.type === 'image_url').length : 0,
    stage: String(payload.messages?.[0]?.content).includes('独立图文核对员') ? 'visual-review' : 'model', startedAt: new Date().toISOString(), bytes: 0 };
  requests.push(entry); saveRequests();
  try {
    const response = await fetch(url, init);
    entry.httpStatus = response.status; entry.headersMs = Date.now() - began; saveRequests();
    if (!response.body) return response;
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        entry.bytes += chunk.length;
        entry.firstByteMs ??= Date.now() - began;
        const text = new TextDecoder().decode(chunk);
        if (/"content"\s*:\s*"[^"\s]/.test(text)) entry.firstContentMs ??= Date.now() - began;
        if (text.includes('[DONE]')) { entry.doneMs = Date.now() - began; saveRequests(); }
        if (text.includes('"error"')) entry.upstreamErrorSeen = true;
        controller.enqueue(chunk);
      },
      flush() { entry.eofMs = Date.now() - began; saveRequests(); },
    }));
    init.signal?.addEventListener('abort', () => { if (!entry.doneMs && !entry.eofMs) { entry.abortedMs = Date.now() - began; saveRequests(); } }, { once: true });
    return new Response(stream, { status: response.status, headers: response.headers });
  } catch (error) { entry.error = error.name; entry.elapsedMs = Date.now() - began; saveRequests(); throw error; }
};
const middleware = createAiMiddleware(config, fetcher);
const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const signal = AbortSignal.timeout(1800000);
async function call(stage, body) {
  const began = Date.now();
  const response = await fetch(`${base}/api/product/${stage}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body), signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') { events.push({ elapsedMs: Date.now() - started, ...event.step }); console.log(`${event.step.label}: ${event.step.detail}`); }
    if (event.type === 'error') throw Object.assign(new Error(event.error.message), { code: event.error.code, details: event.error.details });
    if (event.type === 'result') result = event.data;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) break;
    }
    consume(buffer);
  } finally { void reader.cancel().catch(() => {}); }
  if (result === undefined) throw new Error('Local API returned no completed result');
  stages.push({ stage, elapsedMs: Date.now() - began });
  return result;
}
const report = { passed: false, sourcePath, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), mode: resume ? 'Resume this pipeline generated checkpoint; no manual geometry/plan edits' : 'Fresh live HTTP CAD generation, no model checkpoint seeded',
  confirmationProvenance: 'Synthetic test confirmation through the real confirm route; not a human preview approval', stages, startedAt: new Date().toISOString() };
try {
  // The archived text sample contains real signed images but no preview-set
  // envelope. Assemble only that test metadata; verify every original image.
  let preview = source.previews;
  if (!preview.viewIds) {
    for (const image of preview.images) {
      const { id, briefId, kind, templateId, mimeType, digest, createdAt, signature } = image;
      verifyProductArtifact('image', { id, briefId, kind, templateId, mimeType, digest, createdAt, signature }, config);
      if (createHash('sha256').update(Buffer.from(image.dataUrl.split(',')[1], 'base64')).digest('hex') !== digest) throw new Error('Archived preview bytes changed');
    }
    preview = { ...signProductArtifact('preview', { id: 'fresh-timeout-acceptance-preview', briefId: source.brief.id,
      viewIds: PREVIEW_VIEWS.map(view => view.id), digest: createHash('sha256').update(preview.images.map(image => `${image.templateId}:${image.digest}`).join('\n')).digest('hex'),
      createdAt: new Date().toISOString() }, config), images: preview.images };
    report.previewEnvelopeProvenance = 'Test metadata assembled from four original signed images; images and technical text unchanged';
  }
  const confirmation = await call('confirm', { brief: source.brief, preview: previewReference(preview), confirmed: true });
  const cad = await call('cad', { brief: source.brief, confirmation, images: source.visionImages || source.previews.images.map(({ templateId, dataUrl }) => ({ templateId, dataUrl })) });
  const errors = drawingCoverageErrors(cad, source.brief); if (errors.length) throw new Error(errors.join(';'));
  await fs.writeFile(path.join(root, 'cad.json'), JSON.stringify(cad));
  for (const [i, view] of cad.views.entries()) {
    await fs.writeFile(path.join(root, `figure-${i + 1}.svg`), view.svg);
    await fs.writeFile(path.join(root, `figure-${i + 1}.png`), new Resvg(view.svg).render().asPng());
  }
  const reviewStarted = Date.now();
  report.finalTextReview = await reviewCadDrawings(source.brief, cad.drawingPlan, cad.views, preferCadModel(visionConfig(config), cad.generationModel), signal, fetcher,
    { ...source.materials, drawings: drawingDescription(source.brief, cad.views) });
  stages.push({ stage: 'final-text-review', elapsedMs: Date.now() - reviewStarted });
  report.passed = true; report.figureCount = cad.views.length; report.triangles = cad.triangleCount;
} catch (error) {
  report.error = { code: error.code, message: error.message, details: error.details };
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - started; report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, resume ? 'resume-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, resume ? 'resume-events.json' : 'events.json'), JSON.stringify(events, null, 2));
  await writes;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify(report));
}
