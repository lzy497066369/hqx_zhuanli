import type { ProductBrief, ProductCad } from './productWorkflow.ts';
import { sha256Sync } from './digest.ts';

export const DRAWING_VERSION = 1;
export const MAX_PATENT_FIGURES = 8;
export type DrawingMark = { number: string; name: string; owner: string; kind: string };
export type DrawingAnchor = { number: string; owner: string; point: [number, number, number] };
export type DrawingSurfaceText = { text: string; owner: string; point: [number, number, number]; height: number };
export type DrawingDimension = { from: Pick<DrawingAnchor, 'owner' | 'point'>; to: Pick<DrawingAnchor, 'owner' | 'point'>; axis: 'x' | 'y' | 'z' };
export type DrawingFigure = {
  id: string; title: string; kind: 'overall' | 'orthographic' | 'detail' | 'section' | 'state';
  purpose: string; direction: [number, number, number]; up: [number, number, number];
  marks: string[]; state?: string; parts?: string[];
  focus?: { point: [number, number, number]; radius: number };
  section?: { axis: 'x' | 'y' | 'z'; offset: number; keep: 'positive' | 'negative'; depth?: number };
  /** Compatibility with model results that place slice thickness on the figure. */
  depth?: number;
  surfaceTexts?: DrawingSurfaceText[];
  dimensions?: DrawingDimension[];
};
export type DrawingPlan = { version: 1; figures: DrawingFigure[]; anchors: DrawingAnchor[] };
export type DrawingAnnotation = { number: string; owner: string; anchor: [number, number]; position: [number, number] };

/** Read the frozen technical source, including openings and regions; never renumber it. */
export function drawingMarks(brief: ProductBrief): DrawingMark[] {
  const parts = brief.technicalSource?.plan.parts;
  if (!parts) return brief.design.components.map(p => ({ number: p.number, name: p.name, owner: p.number, kind: 'part' }));
  return parts.map(part => {
    let owner = part;
    const visited = new Set<string>();
    while (owner.kind !== 'part' && owner.kind !== 'assembly') {
      if (!owner.parentId || visited.has(owner.id)) throw new Error(`标号${part.id}缺少所属实体。`);
      visited.add(owner.id);
      const parent = parts.find(p => p.id === owner.parentId);
      if (!parent) throw new Error(`标号${part.id}所属实体不存在。`);
      owner = parent;
    }
    return { number: part.id, name: part.name, owner: owner.id, kind: part.kind };
  });
}
const point = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 20000);
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export function drawingPlanErrors(value: unknown, marks?: DrawingMark[]): string[] {
  if (!value || typeof value !== 'object') return ['缺少附图计划。'];
  const p = value as DrawingPlan, errors: string[] = [];
  if (p.version !== DRAWING_VERSION || !Array.isArray(p.figures) || !p.figures.length || p.figures.length > MAX_PATENT_FIGURES || !Array.isArray(p.anchors) || p.anchors.length > 30) return ['附图计划应含1至8张图及最多30个局部结构锚点。'];
  for (const [i, f] of p.figures.entries()) {
    if (!f || f.id !== `figure-${i + 1}` || !text(f.title, 100) || !text(f.purpose, 1000) || !['overall', 'orthographic', 'detail', 'section', 'state'].includes(f.kind) ||
      !point(f.direction) || Math.hypot(...f.direction) < .001 || !point(f.up) || Math.hypot(...f.up) < .001 ||
      !Array.isArray(f.marks) || !f.marks.length || f.marks.length > 30 || f.marks.some(n => typeof n !== 'string' || !/^[1-9]\d{0,2}$/.test(n)) || new Set(f.marks).size !== f.marks.length) { errors.push(`图${i + 1}的编号、标题、用途、视向或标号无效。`); continue; }
    const cross = [f.direction[1] * f.up[2] - f.direction[2] * f.up[1], f.direction[2] * f.up[0] - f.direction[0] * f.up[2], f.direction[0] * f.up[1] - f.direction[1] * f.up[0]];
    if (Math.hypot(...cross) < .001) errors.push(`图${i + 1}的视向与向上方向平行。`);
    const validState = typeof f.state === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(f.state);
    if ((f.kind === 'state' && !validState) || (f.state !== undefined && (!validState || !['state', 'section', 'detail'].includes(f.kind)))) errors.push(`图${i + 1}状态图须指定真实的状态模型。`);
    if (f.focus !== undefined && (!['detail', 'section'].includes(f.kind) || !f.focus || !point(f.focus.point) || !Number.isFinite(f.focus.radius) || f.focus.radius < .1 || f.focus.radius > 20000)) errors.push(`图${i + 1}局部放大范围无效。`);
    if (f.kind === 'detail') {
      if (!Array.isArray(f.parts) || !f.parts.length || new Set(f.parts).size !== f.parts.length || f.parts.some(id => !/^[1-9]\d{0,2}$/.test(id))) errors.push(`图${i + 1}局部图须指定来自完整模型的部件。`);
    } else if (f.parts !== undefined) errors.push(`图${i + 1}非局部图不能删除部件。`);
    if (f.kind === 'section') {
      if (!f.section || !['x', 'y', 'z'].includes(f.section.axis) || !Number.isFinite(f.section.offset) || Math.abs(f.section.offset) > 20000 || !['positive', 'negative'].includes(f.section.keep)) errors.push(`图${i + 1}须给出剖切平面。`);
      if (f.section?.depth !== undefined && (!Number.isFinite(f.section.depth) || f.section.depth < .02 || f.section.depth > 50)) errors.push(`图${i + 1}局部断面的截取厚度无效。`);
      if (f.depth !== undefined && (!Number.isFinite(f.depth) || f.depth < .02 || f.depth > 50)) errors.push(`图${i + 1}局部断面的截取厚度无效。`);
      if (f.depth !== undefined && f.section?.depth !== undefined && f.depth !== f.section.depth) errors.push(`图${i + 1}两处截取厚度不一致，请统一depth与section.depth。`);
    } else if (f.section !== undefined) errors.push(`图${i + 1}非剖视图不能剖切。`);
    if (f.kind !== 'section' && f.depth !== undefined) errors.push(`图${i + 1}非剖视图不能设置截取厚度。`);
    if (marks && f.marks.some(n => !marks.some(m => m.number === n))) errors.push(`图${i + 1}含正文中不存在的标号。`);
    if (marks && Array.isArray(f.parts) && f.parts.some(n => !marks.some(m => m.number === n && m.owner === n))) errors.push(`图${i + 1}局部图部件不存在。`);
    const surfacePoint = (p: unknown) => !!p && typeof p === 'object' && point((p as DrawingAnchor).point) && /^[1-9]\d{0,2}$/.test((p as DrawingAnchor).owner) && (!marks || marks.some(m => m.number === (p as DrawingAnchor).owner && m.owner === m.number));
    if (f.surfaceTexts !== undefined && (!Array.isArray(f.surfaceTexts) || f.surfaceTexts.length > 6 || f.surfaceTexts.some(t => !surfacePoint(t) || !text(t.text, 12) || !/^[\p{L}\p{N} /+−-]+$/u.test(t.text) || /^\d+$/.test(t.text) || !Number.isFinite(t.height) || t.height < .5 || t.height > 20))) errors.push(`图${i+1}表面文字须为原文中的简短标识，并指定所属实体、表面点和合理字高。`);
    if (f.dimensions !== undefined && (!Array.isArray(f.dimensions) || f.dimensions.length > 1 || f.dimensions.some(d => !d || !['x','y','z'].includes(d.axis) || !surfacePoint(d.from) || !surfacePoint(d.to) || Math.abs(d.from.point['xyz'.indexOf(d.axis)]-d.to.point['xyz'.indexOf(d.axis)]) < .01))) errors.push(`图${i+1}最多标注一项真实间隙尺寸，两端须对应可见实体表面。`);
  }
  if (!p.figures.some(f => f && ['overall', 'state'].includes(f.kind))) errors.push('至少需要一张完整装配图或工作状态图。');
  for (const a of p.anchors) if (!a || !/^[1-9]\d{0,2}$/.test(a.number) || !/^[1-9]\d{0,2}$/.test(a.owner) || !point(a.point) || (marks && !marks.some(m => m.number === a.number && m.owner === a.owner && m.number !== m.owner))) errors.push('局部结构锚点须对应原文编号及正确所属实体。');
  if (new Set(p.anchors.map(a => a?.number)).size !== p.anchors.length) errors.push('局部结构锚点编号重复。');
  if (marks) {
    const missing = marks.filter(m => !p.figures.some(f => Array.isArray(f?.marks) && f.marks.includes(m.number)));
    if (missing.length) errors.push(`附图计划漏标：${missing.map(m => `${m.number} ${m.name}`).join('；')}。`);
    const noAnchor = marks.filter(m => m.number !== m.owner && !p.anchors.some(a => a?.number === m.number));
    if (noAnchor.length) errors.push(`孔槽或局部结构缺少真实表面锚点：${noAnchor.map(m => m.number).join('、')}。`);
  }
  return errors;
}
export function drawingManifestDigest(cad: ProductCad): string {
  const value = JSON.stringify(cad.views.map(v => ({ id: v.view, title: v.title, digest: v.digest })));
  return Array.from(sha256Sync(new TextEncoder().encode(value)), b => b.toString(16).padStart(2, '0')).join('');
}
export function drawingDescription(brief: ProductBrief, views: {title: string}[]): string {
  return views.map((view,i) => `图${i+1}为本产品的${view.title}。`).join('\n') +
    '\n附图标记：' + drawingMarks(brief).map(part => `${part.number}、${part.name}`).join('；') + '。';
}
export function drawingCoverageErrors(cad: ProductCad, brief: ProductBrief): string[] {
  if (cad.drawingVersion !== DRAWING_VERSION || !cad.drawingPlan) return ['附图尚未通过完整标号校验，请重新生成附图。'];
  const marks = drawingMarks(brief);
  const errors = drawingPlanErrors(cad.drawingPlan, marks);
  if (errors.length) return errors;
  if (cad.views.length !== cad.drawingPlan.figures.length) errors.push('实际附图数量与计划不一致。');
  for (const [i, f] of cad.drawingPlan.figures.entries()) {
    const view = cad.views[i];
    if (!view || view.view !== f.id || view.title !== f.title) { errors.push(`图${i + 1}顺序或标题不一致。`); continue; }
    const numbers = view.annotations?.map(a => a.number) || [];
    if (new Set(numbers).size !== numbers.length || f.marks.some(n => !numbers.includes(n)) || numbers.some(n => !f.marks.includes(n))) errors.push(`图${i + 1}实际标号不完整或含多余标号。`);
    const drawn = [...view.svg.matchAll(/<text\b[^>]*>([1-9]\d{0,2})<\/text>/g)].map(m => m[1]);
    if (JSON.stringify([...drawn].sort()) !== JSON.stringify([...numbers].sort())) errors.push(`图${i + 1}图片中的标号与校验记录不一致。`);
    for (const a of view.annotations || []) {
      if (!marks.some(m => m.number === a.number && m.owner === a.owner) || [a.anchor, a.position].some(p => p[0] < 0 || p[0] >= view.width || p[1] < 0 || p[1] >= view.height)) errors.push(`图${i + 1}标号${a.number}指向实体或位置无效。`);
    }
  }
  return errors;
}
