import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { renderMeshView } from './meshFigure.ts';
import type { FreeCadRun } from './productCad.ts';
import type { DrawingPlan } from '../src/features/product/productDrawing.ts';

const { run, plan, title } = workerData as { run: FreeCadRun; plan: DrawingPlan; title: string };
try {
  const views = [], findings: string[] = [];
  for (const [index, f] of plan.figures.entries()) {
    try {
      const model = run.figures[index];
      if (!model || model.id !== f.id) throw new Error(`图${index+1}附图模型与计划不一致。`);
      const result = renderMeshView(model.mesh, {
        direction: f.direction, up: f.up, focus: f.focus, partLabels: true, requiredLabels: f.marks, forceLabelParts: f.marks,
        externalLabels: f.kind === 'section', surfaceTexts: f.surfaceTexts, dimensions: f.dimensions,
        labels: model.anchors.map(a => ({ text: a.number, owner: a.owner, point: a.point })), label: `${title} 图${index+1} ${f.title}`,
      });
      const missing = f.marks.filter(n => !result.labelledParts.includes(n));
      if (missing.length) throw new Error(`图${index+1}存在被遮挡或锚点无效的标号：${missing.join('、')}。请调整视向、剖切面或补充局部图，不得在不可见部件上强行标注。`);
      if (!result.visibleSegments || result.svg.length > 600000) throw new Error(`图${index+1}没有有效轮廓或过于复杂。`);
      views.push({ view: f.id, title: f.title, svg: result.svg, width: result.width, height: result.height, annotations: result.annotations,
        digest: createHash('sha256').update(result.svg).digest('hex') });
    } catch (error) { findings.push(error instanceof Error ? error.message : `图${index+1}投影失败。`); }
  }
  if (findings.length) parentPort!.postMessage({ error: '附图标号或结构检查未通过。', findings });
  else parentPort!.postMessage({ views });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : '附图投影失败。' });
}
