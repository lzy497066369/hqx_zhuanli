// One reference-image request using a saved test product; never re-run after a saved result.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAiConfig } from '../../server/drawingAi.ts';
import { generateProductImage } from '../../server/productImages.ts';

const output = path.resolve('artifacts/product-reference-2026-10-13');
const reportPath = path.join(output, 'provider-report.json');
try {
  const previous = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (previous.requests > 0) { console.log(JSON.stringify(previous)); process.exit(previous.success ? 0 : 1); }
} catch { /* First attempt. */ }
const state = JSON.parse(await fs.readFile('artifacts/redraw-live-2026-10-10/state.json', 'utf8'));
const heroBytes = await fs.readFile('artifacts/redraw-live-2026-10-10/color-hero.png');
const hero = { ...state.previews.images.find(image => image.templateId === 'color-hero'),
  mimeType: 'image/png', digest: createHash('sha256').update(heroBytes).digest('hex'),
  dataUrl: `data:image/png;base64,${heroBytes.toString('base64')}` };
const config = readAiConfig(process.env);
const report = { endpoint: 'images/edits', model: config.image.model, view: 'color-right', startedAt: new Date().toISOString(), requests: 0 };
await fs.mkdir(output, { recursive: true });
const fetcher = async (url, init) => {
  report.requests++;
  report.uploadedReference = init.body instanceof FormData && init.body.get('image') instanceof Blob;
  const response = await fetch(url, init);
  report.status = response.status;
  return response;
};
try {
  const image = await generateProductImage(state.brief2, 'preview', 'color-right', config, AbortSignal.timeout(240000), fetcher, hero);
  const ext = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  report.success = true;
  report.output = `reference-right.${ext}`;
  report.digest = image.digest;
  await fs.writeFile(path.join(output, report.output), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
  await fs.writeFile(path.join(output, 'reference-prompt.txt'), image.prompt);
} catch (error) {
  report.success = false;
  report.code = error.code;
  report.message = error.message;
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
