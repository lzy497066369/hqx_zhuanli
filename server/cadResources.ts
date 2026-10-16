import { Worker } from 'node:worker_threads';
import { AiFailure } from './aiSupport.ts';
import type { FreeCadRun } from './productCad.ts';
import type { DrawingPlan } from '../src/features/product/productDrawing.ts';
import type { CadViewDrawing } from '../src/features/product/productWorkflow.ts';

/** Bound both process and raster memory use; aborted queued jobs never start a worker. */
let active = 0;
const queue: { start: () => void; signal: AbortSignal; cancel: () => void }[] = [];
export async function withCadSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new AiFailure(499, 'AI_CANCELLED', '已取消附图生成。');
  if (active >= 2) await new Promise<void>((resolve, reject) => {
    if (queue.length >= 64) { reject(new AiFailure(429, 'CAD_BUSY', '附图任务较多，请稍后重试；已有成果保留。')); return; }
    const item = { signal, start: resolve, cancel: () => {
      const at = queue.indexOf(item);
      if (at >= 0) queue.splice(at, 1);
      reject(new AiFailure(499, 'AI_CANCELLED', '已取消等待中的附图任务。'));
    } };
    queue.push(item);
    signal.addEventListener('abort', item.cancel, { once: true });
  });
  else active++;
  try {
    if (signal.aborted) throw new AiFailure(499, 'AI_CANCELLED', '已取消附图生成。');
    return await work();
  } finally {
    const next = queue.shift();
    if (next) { next.signal.removeEventListener('abort', next.cancel); next.start(); }
    else active--;
  }
}
export function renderPlannedFigures(run: FreeCadRun, plan: DrawingPlan, title: string, signal: AbortSignal): Promise<CadViewDrawing[]> {
  return runCadWorker<CadViewDrawing[]>('./cadRenderWorker.ts', { run, plan, title }, signal);
}
export function rasterizeCadViews(views: CadViewDrawing[], signal: AbortSignal): Promise<string[]> {
  return withCadSlot(signal, () => runCadWorker<string[]>('./cadRasterWorker.ts', { views }, signal));
}
function runCadWorker<T>(module: string, workerData: unknown, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AiFailure(499, 'AI_CANCELLED', '已取消附图投影。'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(module, import.meta.url), {
      workerData, execArgv: ['--experimental-strip-types'], resourceLimits: { maxOldGenerationSizeMb: 384 },
    });
    let done = false;
    const finish = (error?: Error, views?: T) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      void worker.terminate();
      if (error) reject(error); else resolve(views!);
    };
    const cancel = () => finish(new AiFailure(499, 'AI_CANCELLED', '已取消附图投影。'));
    const timer = setTimeout(() => finish(new AiFailure(504, 'CAD_RENDER_TIMEOUT', '附图投影超时，已释放任务资源。')), 120000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    worker.on('message', result => finish(result.error ? new AiFailure(502, 'CAD_DRAWING_INVALID', '附图标号或结构检查未通过。',
      Array.isArray(result.findings) && result.findings.length ? result.findings : [result.error]) : undefined, result.views ?? result.images));
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!done) finish(new AiFailure(502, 'CAD_RENDER_FAILED', `附图投影进程提前退出（${code}）。`)); });
  });
}
