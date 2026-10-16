import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';
import type { CadViewDrawing } from '../src/features/product/productWorkflow.ts';
try {
  const images = (workerData.views as CadViewDrawing[]).map(view =>
    `data:image/png;base64,${new Resvg(view.svg, { fitTo: { mode: 'width', value: 1400 } }).render().asPng().toString('base64')}`);
  parentPort!.postMessage({ images });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : '附图栅格化失败。' });
}
