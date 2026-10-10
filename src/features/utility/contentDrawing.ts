import { isPatentResearch, isProductConcept } from './patentResearch.ts';
import { getModelVersion, isPatentStructureModel, modelToComponents } from './patentStructure.ts';
import type { PatentResearch, ProductConcept } from './patentResearch.ts';
import { box, cylinder } from './drawingModel.ts';
import type { AssemblyModel, Face3, ModelPart, Vec3 } from './drawingModel.ts';
import type { PatentStructureModel } from './patentStructure.ts';
import { geometryShapeAliases, geometryShapeHelp, geometryShapeLabels, isGeometrySpec } from './geometrySpec.ts';
import type { PatentShape } from './geometrySpec.ts';

export const CONTENT_MODEL_REVISION = 'utility-content-model-v1';
export type ComponentSpec = {
  /** Legacy display ordinal; never used as the structural identity. */
  id: number;
  /** PatentStructureModel component identity, e.g. C01 or C07. */
  componentId?: string;
  /** Patent-facing number shown in drawings and formal text. */
  referenceNo?: string;
  name: string;
  /** Human-readable visible contour cue used by the drawing renderer. */
  visualFeature?: string;
  shape: PatentShape;
  position: [number, number, number];
  size: [number, number, number];
  rotation: [number, number, number];
  surfaceGrid?: [number, number];
};
export type AiProvenance = {
  research?: PatentResearch;
  concept?: ProductConcept;
  model: string;
  source: string;
  generatedAt: string;
  summary: string;
  assumptions: string[];
};
export type ContentDesign = {
  revision: typeof CONTENT_MODEL_REVISION;
  title: string;
  source: string;
  generatedAt: string;
  components: ComponentSpec[];
  detailPartId: number;
  detailComponentId?: string;
  sourceModelVersion?: string;
  /** Downstream drafting and drawings are gated on an explicitly adopted model. */
  structureModel?: PatentStructureModel;
  ai?: AiProvenance;
};
export const GEOMETRY_FORMAT = `每行一个部件，使用 | 分隔，数字以逗号分隔；单位为 mm。
名称 | 形状 | 位置 x,y,z | 尺寸 | 旋转 x,y,z（可省略，默认 0,0,0）
${Object.entries(geometryShapeLabels).map(([shape, label]) => `${label}：${geometryShapeHelp[shape as PatentShape]}`).join('\n')}
圆柱、圆管、圆锥、棱柱、弹簧和螺纹圆柱默认沿 Z 轴；位置按形状定义为底面中心、球心或中心；旋转绕部件位置依次绕 X、Y、Z 轴，单位为度。
所有部件使用同一坐标系，X 向右、Y 向后、Z 向上。`;
export const GEOMETRY_HELP = `${GEOMETRY_FORMAT}只填写已确认的几何信息，手动解析器不会自动猜测装配关系。`;
export const GEOMETRY_EXAMPLE = '底座 | 长方体 | 0,0,0 | 120,80,10\n立柱 | 圆柱体 | 60,40,10 | 8,100';
export function isComponentSpec(value: unknown): value is ComponentSpec {
  if (!value || typeof value !== 'object') return false;
  const p = value as ComponentSpec;
  return Number.isInteger(p.id) && p.id > 0 && p.id <= 999 && (p.componentId === undefined || /^C\d{2,3}$/u.test(p.componentId)) && (p.referenceNo === undefined || /^\d{1,3}$/u.test(p.referenceNo)) && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 40 && (p.visualFeature === undefined || typeof p.visualFeature === 'string' && p.visualFeature.length <= 300) &&
    isGeometrySpec(p);
}
export function isAiProvenance(value: unknown): value is AiProvenance {
  if (!value || typeof value !== 'object') return false;
  const ai = value as AiProvenance;
  return (ai.research === undefined || isPatentResearch(ai.research)) && (ai.concept === undefined || isProductConcept(ai.concept)) && typeof ai.model === 'string' && ai.model.length > 0 && ai.model.length <= 100 &&
    typeof ai.source === 'string' && ai.source.length <= 150000 &&
    typeof ai.generatedAt === 'string' && Number.isFinite(Date.parse(ai.generatedAt)) &&
    typeof ai.summary === 'string' && ai.summary.length <= 3000 &&
    Array.isArray(ai.assumptions) && ai.assumptions.length <= 20 && ai.assumptions.every(s => typeof s === 'string' && s.length <= 1000);
}
export function isContentDesign(value: unknown): value is ContentDesign {
  if (!value || typeof value !== 'object') return false;
  const d = value as ContentDesign;
  return (d.ai === undefined || isAiProvenance(d.ai)) && (d.structureModel === undefined || isPatentStructureModel(d.structureModel)) && d.revision === CONTENT_MODEL_REVISION && typeof d.title === 'string' && d.title.length > 0 &&
    typeof d.source === 'string' && typeof d.generatedAt === 'string' && Array.isArray(d.components) &&
    d.components.length > 0 && d.components.length <= 30 &&
    d.components.every(isComponentSpec) && new Set(d.components.map(p => p.id)).size === d.components.length &&
    (d.sourceModelVersion === undefined || (typeof d.sourceModelVersion === 'string' && d.sourceModelVersion.length > 0 && d.sourceModelVersion.length <= 120)) &&
    (d.detailComponentId === undefined || d.components.some(p => p.componentId === d.detailComponentId)) &&
    Number.isInteger(d.detailPartId) && d.components.some(p => p.id === d.detailPartId);
}
// Deliberately a strict, user-visible format, not pretend natural-language/AI understanding.
// Every nonempty line must parse: never silently drop a component or unknown instruction.
export function parseGeometry(text: string): { components: ComponentSpec[]; errors: string[] } {
  const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { components: [], errors: ['请补充部件几何内容：名称、形状、尺寸及装配位置。'] };
  if (lines.length > 30) return { components: [], errors: ['最多支持 30 个部件，请拆分复杂装配。'] };
  const components: ComponentSpec[] = [], errors: string[] = [];
  const shapes = geometryShapeAliases;
  const numbers = (s: string) => s.split(/[,，]/).map(v => v.trim() && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()) ? Number(v) : NaN);
  lines.forEach((line, index) => {
    const fields = line.split(/[|｜]/).map(s => s.trim());
    const fail = (message: string) => errors.push(`第 ${index + 1} 行：${message}`);
    if (fields.length < 4 || fields.length > 5) { fail('请使用“名称 | 形状 | 位置 | 尺寸 | 旋转”格式，不会将自由文本自动猜成图形。'); return; }
    const [name, type, origin, dimensions, angles = '0,0,0'] = fields;
    const shape = shapes[type];
    if (!shape) { fail(`目前支持${Object.values(geometryShapeLabels).join('、')}；无法由参数化线框表达的自由曲面需另行建模。`); return; }
    const size = numbers(dimensions);
    if (size.length !== (shape === 'cylinder' ? 2 : shape === 'sphere' ? 1 : 3)) { fail(`尺寸项数不符：${geometryShapeHelp[shape]}`); return; }
    if (shape === 'cylinder') size.push(0);
    if (shape === 'sphere') size.push(0, 0);
    const part = { id: index + 1, name, shape, position: numbers(origin), size, rotation: numbers(angles) };
    if (!isComponentSpec(part)) { fail('名称须为 1–40 字；位置 ±10000，尺寸 0.1–10000，旋转 ±360°；圆管内半径必须小于外半径，齿轮齿数须为 8–120 的整数，禁止空数字。'); return; }
    if (components.some(p => p.name === name)) { fail('部件名称重复，请用“左支架 / 右支架”等区分。'); return; }
    components.push(part);
  });
  return { components: errors.length ? [] : components, errors };
}
export function drawingSource(title: string, drawing: { structure: string; workingPrinciple: string; technicalField: string; geometryText?: string }) {
  return JSON.stringify([title, drawing.technicalField, drawing.structure, drawing.workingPrinciple, drawing.geometryText || '']);
}
export function isDrawingCurrent(title: string, drawing: { structure: string; workingPrinciple: string; technicalField: string; geometryText?: string; design?: ContentDesign }) {
  return !!drawing.design && drawing.design.title === title && drawing.design.source === drawingSource(title, drawing);
}
function transform(point: Vec3, spec: ComponentSpec): Vec3 {
  let [x, y, z] = point;
  const [a, b, c] = spec.rotation.map(n => n * Math.PI / 180);
  [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
  [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
  return [x + spec.position[0], y + spec.position[1], z + spec.position[2]];
}
function componentGeometry(spec: ComponentSpec): ModelPart {
  let raw: ModelPart;
  if (spec.shape === 'box') {
    raw = box(spec.id, [0, 0, 0], spec.size);
    // visualFeature is the human-readable appearance contract. Explicit
    // geometry remains authoritative; the feature only supplies the visible
    // panel grid when the model describes that grid but omitted its optional
    // geometry hint.
    const surfaceGrid = spec.surfaceGrid || (/电池片|板面网格|网格线/u.test(spec.visualFeature || '') ? [8, 5] as [number, number] : undefined);
    if (surfaceGrid) {
      const [columns, rows] = surfaceGrid;
      const [length, width, height] = spec.size;
      for (let column = 1; column < columns; column++) {
        const x = column * length / columns;
        raw.edges.push([[x, 0, height], [x, width, height]]);
      }
      for (let row = 1; row < rows; row++) {
        const y = row * width / rows;
        raw.edges.push([[0, y, height], [length, y, height]]);
      }
    }
  }
  else if (spec.shape === 'spur_gear' || spec.shape === 'ring_gear') {
    const [module, teeth, width] = spec.size;
    const internal = spec.shape === 'ring_gear';
    const rootRadius = module * (teeth + (internal ? 2.5 : -2.5)) / 2;
    const tipRadius = module * (teeth + (internal ? -2 : 2)) / 2;
    const edges: ModelPart['edges'] = [];
    // 齿廓挤出侧面 + 外齿轮前后端面（凹齿形多边形），用于零件间遮挡的消隐分类。
    // 内齿轮（ring_gear）端面为带孔环形，不参与遮挡，仅外圆柱侧面参与。
    const faces: Face3[] = [];
    const point = (radius: number, angle: number, z: number): Vec3 => [radius * Math.cos(angle), radius * Math.sin(angle), z];
    const outline: Vec3[] = [];
    for (let tooth = 0; tooth < teeth; tooth++) {
      const start = tooth * 2 * Math.PI / teeth;
      const angles = [0, .18, .3, .7, .82, 1].map(fraction => start + fraction * 2 * Math.PI / teeth);
      const radii = [rootRadius, rootRadius, tipRadius, tipRadius, rootRadius, rootRadius];
      for (let segment = 0; segment < 5; segment++) {
        for (const z of [0, width]) edges.push([point(radii[segment], angles[segment], z), point(radii[segment + 1], angles[segment + 1], z)]);
        faces.push({ vertices: [
          point(radii[segment], angles[segment], 0), point(radii[segment + 1], angles[segment + 1], 0),
          point(radii[segment + 1], angles[segment + 1], width), point(radii[segment], angles[segment], width)] });
        if (!internal) outline.push(point(radii[segment], angles[segment], 0));
      }
      for (const segment of [0, 2, 3, 4]) edges.push([point(radii[segment], angles[segment], 0), point(radii[segment], angles[segment], width)]);
    }
    if (!internal) {
      faces.push({ vertices: outline.map(([x, y]) => [x, y, 0] as Vec3) });
      faces.push({ vertices: outline.map(([x, y]) => [x, y, width] as Vec3) });
    }
    if (internal) {
      const outerRadius = module * (teeth + 8) / 2;
      for (let segment = 0; segment < 64; segment++) {
        const a = segment * 2 * Math.PI / 64, b = (segment + 1) * 2 * Math.PI / 64;
        for (const z of [0, width]) edges.push([point(outerRadius, a, z), point(outerRadius, b, z)]);
        faces.push({ vertices: [point(outerRadius, a, 0), point(outerRadius, b, 0), point(outerRadius, b, width), point(outerRadius, a, width)] });
        if (segment % 8 === 0) edges.push([point(outerRadius, a, 0), point(outerRadius, a, width)]);
      }
    }
    raw = { id: spec.id, edges, faces, anchor: [0, 0, width / 2] };
  } else if (spec.shape === 'sphere' || spec.shape === 'ellipsoid') {
    const [rx, ry, rz] = spec.shape === 'sphere' ? [spec.size[0], spec.size[0], spec.size[0]] : spec.size;
    const edges: ModelPart['edges'] = [];
    // 经纬网格四边形面，用于零件间遮挡的消隐分类（背面网格画成虚线）。
    const faces: Face3[] = [];
    const rings = 12, segments = 24;
    const point = (latitude: number, longitude: number): Vec3 => [rx * Math.cos(latitude) * Math.cos(longitude), ry * Math.cos(latitude) * Math.sin(longitude), rz * Math.sin(latitude)];
    for (let ring = 0; ring <= rings; ring++) {
      const latitude = -Math.PI / 2 + ring * Math.PI / rings;
      const nextLatitude = -Math.PI / 2 + (ring + 1) * Math.PI / rings;
      for (let segment = 0; segment < segments; segment++) {
        const a = point(latitude, segment * 2 * Math.PI / segments);
        const b = point(latitude, (segment + 1) * 2 * Math.PI / segments);
        edges.push([a, b]);
        if (ring < rings) {
          const d = point(nextLatitude, segment * 2 * Math.PI / segments);
          edges.push([a, d]);
          faces.push({ vertices: [a, b, point(nextLatitude, (segment + 1) * 2 * Math.PI / segments), d] });
        }
      }
    }
    raw = { id: spec.id, edges, faces, anchor: [0, 0, 0] };
  } else if (spec.shape === 'cone' || spec.shape === 'prism') {
    const [bottomRadius, second, third] = spec.size;
    const sides = spec.shape === 'prism' ? second : 32;
    const height = spec.shape === 'prism' ? third : second;
    const topRadius = spec.shape === 'cone' ? third : bottomRadius;
    const edges: ModelPart['edges'] = [];
    const faces: Face3[] = [];
    const point = (radius: number, angle: number, z: number): Vec3 => [radius * Math.cos(angle), radius * Math.sin(angle), z];
    const ringPoint = (radius: number, segment: number, z: number): Vec3 => point(radius, segment * 2 * Math.PI / sides, z);
    for (let segment = 0; segment < sides; segment++) {
      const a = segment * 2 * Math.PI / sides, b = (segment + 1) * 2 * Math.PI / sides;
      edges.push([point(bottomRadius, a, 0), point(bottomRadius, b, 0)], [point(topRadius, a, height), point(topRadius, b, height)], [point(bottomRadius, a, 0), point(topRadius, a, height)]);
      faces.push({ vertices: [point(bottomRadius, a, 0), point(bottomRadius, b, 0), point(topRadius, b, height), point(topRadius, a, height)] });
    }
    if (bottomRadius > 1e-9) faces.push({ vertices: Array.from({ length: sides }, (_, segment) => ringPoint(bottomRadius, segment, 0)) });
    if (topRadius > 1e-9) faces.push({ vertices: Array.from({ length: sides }, (_, segment) => ringPoint(topRadius, segment, height)) });
    raw = { id: spec.id, edges, faces, anchor: [0, 0, height / 2] };
  } else if (spec.shape === 'torus') {
    const [majorRadius, tubeRadius] = spec.size;
    const edges: ModelPart['edges'] = [];
    // 管壁四边形面，用于零件间遮挡的消隐分类（背面管壁画成虚线）。
    const faces: Face3[] = [];
    const majorSegments = 32, tubeSegments = 12;
    const point = (major: number, tube: number): Vec3 => [
      (majorRadius + tubeRadius * Math.cos(tube)) * Math.cos(major),
      (majorRadius + tubeRadius * Math.cos(tube)) * Math.sin(major),
      tubeRadius * Math.sin(tube),
    ];
    for (let major = 0; major < majorSegments; major++) for (let tube = 0; tube < tubeSegments; tube++) {
      const a = point(major * 2 * Math.PI / majorSegments, tube * 2 * Math.PI / tubeSegments);
      const b = point((major + 1) * 2 * Math.PI / majorSegments, tube * 2 * Math.PI / tubeSegments);
      const c = point((major + 1) * 2 * Math.PI / majorSegments, (tube + 1) * 2 * Math.PI / tubeSegments);
      const d = point(major * 2 * Math.PI / majorSegments, (tube + 1) * 2 * Math.PI / tubeSegments);
      edges.push([a, b], [a, d]);
      faces.push({ vertices: [a, b, c, d] });
    }
    raw = { id: spec.id, edges, faces, anchor: [0, 0, 0] };
  } else if (spec.shape === 'spring' || spec.shape === 'threaded_cylinder') {
    const [radius, length, pitchOrWire] = spec.size;
    const edges: ModelPart['edges'] = [];
    const turns = spec.shape === 'spring' ? Math.max(2, length / (radius * 1.5)) : Math.max(1, length / pitchOrWire);
    const points = 96;
    const helix = (angle: number, radialOffset: number): Vec3 => [
      (radius + radialOffset) * Math.cos(angle),
      (radius + radialOffset) * Math.sin(angle),
      length * (angle / (turns * 2 * Math.PI)),
    ];
    for (let index = 0; index < points; index++) {
      const angle = index * turns * 2 * Math.PI / (points - 1);
      const next = (index + 1) * turns * 2 * Math.PI / (points - 1);
      edges.push([helix(angle, 0), helix(next, 0)]);
      if (spec.shape === 'spring' && pitchOrWire > 0) edges.push([helix(angle, pitchOrWire), helix(next, pitchOrWire)]);
    }
    if (spec.shape === 'threaded_cylinder') {
      const body = cylinder(spec.id, [0, 0, 0], radius, length);
      const toZ = ([x, y, z]: Vec3): Vec3 => [x, z, y];
      const bodyEdges = body.edges.map(([a, b]) => [toZ(a), toZ(b)] as const);
      raw = { id: spec.id, edges: [...bodyEdges, ...edges],
        faces: body.faces?.map(face => ({ vertices: face.vertices.map(toZ) })),
        anchor: [0, 0, length / 2] };
    } else raw = { id: spec.id, edges, anchor: [0, 0, length / 2] };
  } else {
    raw = cylinder(spec.id, [0, 0, 0], spec.size[0], spec.size[1]);
    if (spec.shape === 'tube') raw.edges.push(...cylinder(spec.id, [0, 0, 0], spec.size[2], spec.size[1]).edges);
    // Existing cylinder primitive is Y-axis; all content specs use Z-axis.
    // 内层圆管边线无面数据：自身不参与遮挡其他零件，但其边线仍会被其他零件的面遮挡。
    const toZ = ([x, y, z]: Vec3): Vec3 => [x, z, y];
    raw = { ...raw, edges: raw.edges.map(([a, b]) => [toZ(a), toZ(b)]), faces: raw.faces?.map(face => ({ vertices: face.vertices.map(toZ) })), anchor: toZ(raw.anchor) };
  }
  return {
    ...raw, componentId: spec.componentId, referenceNo: spec.referenceNo, ...(spec.visualFeature ? { visualFeature: spec.visualFeature } : {}),
    edges: raw.edges.map(([a, b]) => [transform(a, spec), transform(b, spec)]),
    faces: raw.faces?.map(face => ({ vertices: face.vertices.map(vertex => transform(vertex, spec)) })),
    anchor: transform(raw.anchor, spec),
  };
}
export function buildContentAssembly(design: ContentDesign): AssemblyModel {
  if (!isContentDesign(design)) throw new Error('部件模型数据无效，请重新生成。');
  if (design.structureModel && (design.sourceModelVersion !== getModelVersion(design.structureModel) ||
      JSON.stringify(design.components) !== JSON.stringify(modelToComponents(design.structureModel)))) {
    throw new Error('附图与来源结构模型不一致，请重新生成附图。');
  }
  const figureComponentIds = design.structureModel
    ? Object.fromEntries(design.structureModel.figureSpecs.map(spec => [spec.kind, spec.componentIds] as const))
    : undefined;
  return {
    revision: CONTENT_MODEL_REVISION,
    parameters: {},
    parts: design.components.map(componentGeometry),
    detailPartIds: [design.detailPartId],
    detailComponentIds: design.detailComponentId ? [design.detailComponentId] : [],
    figureComponentIds,
  };
}
