// Shared geometric primitives and projections. Product geometry is supplied by
// contentDrawing; no default/reference product is drawn for a new project.
export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];
export type Edge3 = readonly [Vec3, Vec3];
/** 凸多边形面，仅用于消隐线分类；不改变已有多边形边线的绘制集合。 */
export type Face3 = { vertices: Vec3[] };
export type Figure = "overall" | "side" | "detail";
export type ModelParameters = { mastHeight: number; carriageHeight: number };
export type ModelPart = {
  id: number;
  componentId?: string;
  referenceNo?: string;
  visualFeature?: string;
  edges: Edge3[];
  /** 凸多边形面：用于零件内/零件间的遮挡消隐分类；缺省时该零件不遮挡其他零件。 */
  faces?: Face3[];
  anchor: Vec3;
  enclosure?: boolean;
};
export type AssemblyModel = {
  revision: string;
  parameters: Record<string, number>;
  parts: ModelPart[];
  detailPartIds: readonly number[];
  detailComponentIds: readonly string[];
  /** Figure-specific component references copied from PatentStructureModel.figureSpecs. */
  figureComponentIds?: Partial<Record<Figure, readonly string[]>>;
};
export type Bounds = { x: number; y: number; width: number; height: number };
export type ProjectedFace = {
  /** 投影后的多边形顶点（已做背面剔除，只含朝向相机的面）。 */
  points: Vec2[];
  /** 面中心沿视线方向的深度（越大越靠近相机），用于画家算法排序。 */
  depth: number;
};
export type ProjectedPart = {
  source: ModelPart;
  /** 可见边（实线）。 */
  edges: (readonly [Vec2, Vec2])[];
  /** 被遮挡的边（虚线，即消隐线）。 */
  hiddenEdges: (readonly [Vec2, Vec2])[];
  /** 可见面（实心白填充用，已做背面剔除）。 */
  faces: ProjectedFace[];
  anchor: Vec2;
};
export type Camera = { right: Vec3; down: Vec3 };

export const MODEL_LIMITS = { mastHeight: [220, 320], carriageHeight: [90, 165] } as const;
export const PATENT_FIGURES = ([
  ["overall", "整体结构"], ["side", "侧面结构"], ["detail", "局部连接"],
] as const).map(([kind, name], index) => ({
  kind, figureIndex: index + 1, figureLabel: `图${index + 1}`,
  id: `FIG-${String(index + 1).padStart(2, "0")}`,
  sourceId: `F${String(index + 1).padStart(2, "0")}`,
  name: `图 ${index + 1} · ${name}`,
}));
export const FIGURE_LABELS = Object.fromEntries(PATENT_FIGURES.map(item => [item.kind, item.figureLabel])) as Record<Figure, string>;

// The supplied historical drawings are treated as visual conventions only:
// portrait A4 page, restrained black linework, generous whitespace and a
// figure label below the drawing. No product geometry or component numbering
// is copied from those documents.
export const PATENT_DRAWING_STYLE = {
  pageTitle: "说明书附图",
  width: 794,
  height: 1123,
  drawingArea: { x: 116, y: 145, width: 562, height: 760 },
  labelGutter: 64,
  labelTop: 205,
  labelBottom: 875,
  figureLabelY: 1028,
  geometryStroke: 1.35,
  leaderStroke: 0.8,
  // Keep the default patent-facing drawing focused on visible contours.
  // Hidden edges remain available in the model for diagnostics and future
  // view-specific rendering.
  showHiddenEdges: false,
} as const;
export const FIGURE_DESCRIPTIONS: Record<Figure, string> = {
  overall: `${FIGURE_LABELS.overall}为装配体的等轴测立体图，部件坐标、比例关系和装配位置与三维母模型一致。`,
  side: `${FIGURE_LABELS.side}为该母模型沿 +X 方向观察的侧向正投影，部件坐标、比例关系和装配位置不变。`,
  detail: `${FIGURE_LABELS.detail}为${FIGURE_LABELS.overall}中所选局部区域的等比例放大，沿用${FIGURE_LABELS.overall}的投影方向，仅裁切和放大，不移动或重组部件。`,
};
// 等轴测：相机位于 +X+Y+Z 卦限，right × down 归一化后为 [1,1,1]/√3。
// 整体图（图1）用等轴测立体视图，更接近实物外观；侧视/局部仍用正投影。
const ISOMETRIC: Camera = {
  right: [1 / Math.SQRT2, -1 / Math.SQRT2, 0],
  down: [1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)],
};
export const CAMERAS: Record<Figure, Camera> = {
  overall: ISOMETRIC,
  side: { right: [0, 1, 0], down: [0, 0, -1] },
  detail: ISOMETRIC,
};
export const SVG_FRAME = { width: PATENT_DRAWING_STYLE.width, height: PATENT_DRAWING_STYLE.height };
export const DRAWING_AREA: Bounds = PATENT_DRAWING_STYLE.drawingArea;

export function isModelParameters(value: unknown): value is ModelParameters {
  if (!value || typeof value !== "object") return false;
  const p = value as ModelParameters;
  return (Object.keys(MODEL_LIMITS) as (keyof ModelParameters)[]).every(key =>
    Number.isFinite(p[key]) && p[key] >= MODEL_LIMITS[key][0] && p[key] <= MODEL_LIMITS[key][1]);
}

export function box(id: number, origin: Vec3, size: Vec3, enclosure = false): ModelPart {
  const vertices: Vec3[] = [];
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    vertices.push([origin[0] + x * size[0], origin[1] + y * size[1], origin[2] + z * size[2]]);
  }
  const edges: Edge3[] = [];
  vertices.forEach((v, i) => {
    for (const bit of [1, 2, 4]) if (!(i & bit)) edges.push([v, vertices[i | bit]]);
  });
  // 顶点编号 v[x + 2y + 4z]；六个四边形面用于消隐线分类。
  const faces: Face3[] = [
    { vertices: [vertices[0], vertices[1], vertices[3], vertices[2]] },
    { vertices: [vertices[4], vertices[6], vertices[7], vertices[5]] },
    { vertices: [vertices[0], vertices[4], vertices[5], vertices[1]] },
    { vertices: [vertices[2], vertices[3], vertices[7], vertices[6]] },
    { vertices: [vertices[0], vertices[2], vertices[6], vertices[4]] },
    { vertices: [vertices[1], vertices[5], vertices[7], vertices[3]] },
  ];
  return { id, edges, faces, anchor: [origin[0] + size[0] / 2, origin[1] + size[1] / 2, origin[2] + size[2] / 2], enclosure };
}

// Cylinders/cones share the Y axis. Rims and generators are world-space edges,
// not circles redrawn separately in each view.
export function cylinder(id: number, origin: Vec3, radius: number, length: number, endRadius = radius): ModelPart {
  const count = 32;
  const ring = (r: number, y: number): Vec3[] => Array.from({ length: count }, (_, i) => {
    const angle = i * 2 * Math.PI / count;
    return [origin[0] + r * Math.cos(angle), y, origin[2] + r * Math.sin(angle)];
  });
  const front = ring(radius, origin[1]);
  const back = ring(endRadius, origin[1] + length);
  const edges: Edge3[] = [];
  for (let i = 0; i < count; i++) {
    edges.push([front[i], front[(i + 1) % count]], [back[i], back[(i + 1) % count]]);
    if (i % 8 === 0) edges.push([front[i], back[i]]);
  }
  // 侧面四边形 + 上下底面多边形，用于消隐线分类。
  const faces: Face3[] = [];
  for (let i = 0; i < count; i++) {
    faces.push({ vertices: [front[i], front[(i + 1) % count], back[(i + 1) % count], back[i]] });
  }
  faces.push({ vertices: [...front] }, { vertices: [...back] });
  return { id, edges, faces, anchor: [origin[0], origin[1] + length / 2, origin[2]] };
}

export function projectPoint(point: Vec3, camera: Camera): Vec2 {
  const dot = (axis: Vec3) => point.reduce((sum, value, index) => sum + value * axis[index], 0);
  return [dot(camera.right), dot(camera.down)];
}

// 视线方向：由场景指向相机，即 right × down（右手系下与投影平面垂直）。
function viewDirection(camera: Camera): Vec3 {
  const [rx, ry, rz] = camera.right;
  const [dx, dy, dz] = camera.down;
  const raw: Vec3 = [ry * dz - rz * dy, rz * dx - rx * dz, rx * dy - ry * dx];
  const norm = Math.hypot(raw[0], raw[1], raw[2]);
  return [raw[0] / norm, raw[1] / norm, raw[2] / norm];
}

// ---- 真实消隐：零件间遮挡 ----
// 旧实现只做单零件背向面分类，零件之间的遮挡完全没算，多零件重叠时所有
// 线条平铺绘制。新实现对每条边按弧长采样，对采样点沿视线向相机做光线投射，
// 与全部零件的全部面求交：射线上在 EPS 之外首次命中任一面即判定被遮挡。
//  - 与边邻接的面（共享该边的两个端点）不参与测试，避免把边自己的面误判；
//  - 投影退化（面与视线平行）或近乎掠射的面不参与测试，避免轮廓线因数值
//    抖动被误判成虚线；
//  - 边的可见/遮挡分段按采样点连续区间切分，在可见性变化处取中点为分界。
// 输出仍沿用实线（可见）/虚线（消隐）绘制，与 UtilityFigure 的渲染约定一致。
type OccluderFace = {
  /** `${partIndex}:${faceIndex}`，用于排除边的邻接面。 */
  key: string;
  /** 投影后的多边形顶点（已剔除退化；可为凹多边形，如齿轮端面）。 */
  projected: Vec2[];
  minX: number; minY: number; maxX: number; maxY: number;
  /** 单位化平面法向，平面方程为 n·x = offset。 */
  nx: number; ny: number; nz: number; offset: number;
  /** n·viewDir（已取绝对值前的原始值，用于掠射判断）。 */
  normalDotView: number;
};

const OCCLUSION_EPS = 1e-4;  // mm：小于此距离的命中视为自相交，忽略
const GRAZING_LIMIT = 0.2;   // |n·viewDir| 小于此值视为掠射面，不参与遮挡
const OCCLUSION_SAMPLE_STEP = 6;  // mm：边采样步长
const OCCLUSION_SAMPLE_MIN = 4;
const OCCLUSION_SAMPLE_MAX = 20;

function planeOf(vertices: Vec3[]): { nx: number; ny: number; nz: number; offset: number } {
  // Newell 法求平面法向，对凸多边形稳健。
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const [ax, ay, az] = vertices[i];
    const [bx, by, bz] = vertices[(i + 1) % vertices.length];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const [px, py, pz] = vertices[0];
  return { nx, ny, nz, offset: nx * px + ny * py + nz * pz };
}

function buildOccluders(parts: ModelPart[], camera: Camera, viewDir: Vec3): OccluderFace[] {
  const faces: OccluderFace[] = [];
  parts.forEach((part, partIndex) => {
    if (part.enclosure || !part.faces) return;
    part.faces.forEach((face, faceIndex) => {
      const projected = face.vertices.map(vertex => projectPoint(vertex, camera));
      let area = 0;
      for (let i = 0; i < projected.length; i++) {
        const [ax, ay] = projected[i];
        const [bx, by] = projected[(i + 1) % projected.length];
        area += ax * by - bx * ay;
      }
      if (Math.abs(area) < 1e-9) return;  // 面与视线平行，无遮挡能力
      const { nx, ny, nz, offset } = planeOf(face.vertices);
      const norm = Math.hypot(nx, ny, nz);
      if (norm < 1e-12) return;
      const ux = nx / norm, uy = ny / norm, uz = nz / norm;
      const normalDotView = ux * viewDir[0] + uy * viewDir[1] + uz * viewDir[2];
      if (Math.abs(normalDotView) < GRAZING_LIMIT) return;  // 掠射面不参与遮挡
      const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
      faces.push({
        key: `${partIndex}:${faceIndex}`,
        projected,
        minX: Math.min(...xs), minY: Math.min(...ys),
        maxX: Math.max(...xs), maxY: Math.max(...ys),
        nx: ux, ny: uy, nz: uz, offset: offset / norm,
        normalDotView,
      });
    });
  });
  return faces;
}

// 射线法（even-odd）判断点是否在多边形内，支持凹多边形（如齿轮端面）。
// 点恰好落在边上时视为内部，避免轮廓线因数值抖动被误判。
function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[j];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (Math.abs(cross) < 1e-9 &&
        px >= Math.min(ax, bx) - 1e-9 && px <= Math.max(ax, bx) + 1e-9 &&
        py >= Math.min(ay, by) - 1e-9 && py <= Math.max(ay, by) + 1e-9) return true;
    if ((ay > py) !== (by > py)) {
      const xIntersect = ax + (py - ay) / (by - ay) * (bx - ax);
      if (xIntersect > px) inside = !inside;
    }
  }
  return inside;
}

function isOccluded(
  point: Vec3, projected: Vec2,
  occluders: OccluderFace[], exclude: ReadonlySet<string>,
): boolean {
  for (const face of occluders) {
    if (exclude.has(face.key)) continue;
    if (projected[0] < face.minX || projected[0] > face.maxX ||
        projected[1] < face.minY || projected[1] > face.maxY) continue;
    const t = (face.offset - (face.nx * point[0] + face.ny * point[1] + face.nz * point[2])) / face.normalDotView;
    if (t < OCCLUSION_EPS) continue;
    if (!pointInPolygon(projected, face.projected)) continue;
    return true;
  }
  return false;
}

function splitOccludedEdge(
  edge: Edge3, adjacentKeys: ReadonlySet<string>,
  occluders: OccluderFace[], camera: Camera,
): { visible: Edge3[]; hidden: Edge3[] } {
  const [a, b] = edge;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const visible: Edge3[] = [], hidden: Edge3[] = [];
  if (length < 1e-9) return { visible, hidden };
  const count = Math.max(OCCLUSION_SAMPLE_MIN,
    Math.min(OCCLUSION_SAMPLE_MAX, Math.ceil(length / OCCLUSION_SAMPLE_STEP)));
  const at = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const flags: boolean[] = [];
  for (let i = 0; i <= count; i++) {
    const p = at(i / count);
    flags.push(isOccluded(p, projectPoint(p, camera), occluders, adjacentKeys));
  }
  let runStart = 0, runHidden = flags[0];
  const flush = (t1: number) => {
    if (t1 - runStart < 1e-9) return;
    const seg: Edge3 = [at(runStart), at(t1)];
    (runHidden ? hidden : visible).push(seg);
  };
  for (let i = 1; i <= count; i++) {
    if (flags[i] !== runHidden) {
      const mid = (i - 0.5) / count;
      flush(mid);
      runStart = mid;
      runHidden = flags[i];
    }
  }
  flush(1);
  return { visible, hidden };
}

export function projectAssembly(model: AssemblyModel, camera: Camera): ProjectedPart[] {
  const viewDir = viewDirection(camera);
  const occluders = buildOccluders(model.parts, camera, viewDir);
  return model.parts.map((source, partIndex) => {
    const project = ([a, b]: Edge3) => [projectPoint(a, camera), projectPoint(b, camera)] as const;
    if (source.enclosure || !source.faces || source.faces.length === 0) {
      // 无面数据的零件：自身不提供遮挡面，但其边线仍参与被遮挡测试
      // （会被其他零件的面正确地部分/全部隐藏）。
      const visible: Edge3[] = [], hidden: Edge3[] = [];
      for (const edge of source.edges) {
        const { visible: v, hidden: h } = splitOccludedEdge(edge, new Set(), occluders, camera);
        visible.push(...v);
        hidden.push(...h);
      }
      return {
        source,
        edges: visible.map(project),
        hiddenEdges: hidden.map(project),
        faces: [],
        anchor: projectPoint(source.anchor, camera),
      };
    }
    const keyOf = (point: Vec3) => point.map(value => value.toFixed(6)).join(',');
    const facesOfVertex = new Map<string, number[]>();
    source.faces.forEach((face, faceIndex) => face.vertices.forEach(vertex => {
      const key = keyOf(vertex);
      const list = facesOfVertex.get(key);
      if (list) list.push(faceIndex); else facesOfVertex.set(key, [faceIndex]);
    }));
    const visible: Edge3[] = [], hidden: Edge3[] = [];
    for (const edge of source.edges) {
      const first = facesOfVertex.get(keyOf(edge[0])) || [];
      const second = new Set(facesOfVertex.get(keyOf(edge[1])) || []);
      const adjacent = new Set<string>();
      for (const faceIndex of first) if (second.has(faceIndex)) adjacent.add(`${partIndex}:${faceIndex}`);
      const split = splitOccludedEdge(edge, adjacent, occluders, camera);
      visible.push(...split.visible);
      hidden.push(...split.hidden);
    }
    // 投影可见面（实心白填充）：背面剔除 + 深度排序
    const faces: ProjectedFace[] = [];
    if (source.faces) {
      for (const face of source.faces) {
        const projected = face.vertices.map(vertex => projectPoint(vertex, camera));
        let area = 0;
        for (let i = 0; i < projected.length; i++) {
          const [ax, ay] = projected[i];
          const [bx, by] = projected[(i + 1) % projected.length];
          area += ax * by - bx * ay;
        }
        if (Math.abs(area) < 1e-9) continue;
        const { nx, ny, nz } = planeOf(face.vertices);
        const norm = Math.hypot(nx, ny, nz);
        if (norm < 1e-12) continue;
        const facing = (nx * viewDir[0] + ny * viewDir[1] + nz * viewDir[2]) / norm;
        if (facing <= 0) continue;  // 背面剔除
        const cx = face.vertices.reduce((sum, v) => sum + v[0], 0) / face.vertices.length;
        const cy = face.vertices.reduce((sum, v) => sum + v[1], 0) / face.vertices.length;
        const cz = face.vertices.reduce((sum, v) => sum + v[2], 0) / face.vertices.length;
        const depth = cx * viewDir[0] + cy * viewDir[1] + cz * viewDir[2];
        faces.push({ points: projected, depth });
      }
    }
    return {
      source,
      edges: visible.map(project),
      hiddenEdges: hidden.map(project),
      faces,
      anchor: projectPoint(source.anchor, camera),
    };
  });
}

export function boundsOf(parts: ProjectedPart[], padding = 0): Bounds {
  // Include hidden geometry in the viewport even when the clean line renderer
  // omits it, so a concealed component does not change scale unpredictably.
  const points = parts.flatMap(part => [...part.edges, ...part.hiddenEdges].flatMap(edge => edge));
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const x = Math.min(...xs) - padding;
  const y = Math.min(...ys) - padding;
  return { x, y, width: Math.max(...xs) + padding - x, height: Math.max(...ys) + padding - y };
}

export function createFigure(model: AssemblyModel, figure: Figure) {
  const projected = projectAssembly(model, CAMERAS[figure]);
  // Keep the complete mother model in every projection. Figure-specific
  // component IDs control the detail viewport and consistency metadata, but
  // must not remove geometry from the rendered SVG: the patent line drawing
  // remains a projection of one common assembly and may contain crossing or
  // partially visible neighbouring parts.
  const allowedIds = model.figureComponentIds?.[figure];
  const parts = allowedIds ? projected.filter(part => !!part.source.componentId && allowedIds.includes(part.source.componentId)) : projected;
  const overallProjected = figure === "side" ? projectAssembly(model, CAMERAS.overall) : projected;
  const detailAllowedIds = model.figureComponentIds?.detail;
  const detailParts = detailAllowedIds
    ? overallProjected.filter(part => !!part.source.componentId && detailAllowedIds.includes(part.source.componentId))
    : overallProjected.filter(part => model.detailPartIds.includes(part.source.id));
  // This rectangle becomes the source viewport of figure 3. Keep all
  // model-declared detail geometry, including crossing neighbours that are
  // explicitly listed by the FigureSpec.
  const detailBounds = boundsOf(detailParts, 8);
  const sourceBounds = figure === "detail" ? detailBounds : boundsOf(parts, 8);
  const scale = Math.min(DRAWING_AREA.width / sourceBounds.width, DRAWING_AREA.height / sourceBounds.height);
  const offset: Vec2 = [
    DRAWING_AREA.x + (DRAWING_AREA.width - sourceBounds.width * scale) / 2 - sourceBounds.x * scale,
    DRAWING_AREA.y + (DRAWING_AREA.height - sourceBounds.height * scale) / 2 - sourceBounds.y * scale,
  ];
  const toSheet = (point: Vec2): Vec2 => [point[0] * scale + offset[0], point[1] * scale + offset[1]];
  const corner = toSheet([sourceBounds.x, sourceBounds.y]);
  return {
    parts, detailBounds, sourceBounds, scale, offset, toSheet,
    clip: { x: corner[0], y: corner[1], width: sourceBounds.width * scale, height: sourceBounds.height * scale },
  };
}

type SheetEdge = readonly [Vec2, Vec2];
const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const interpolate = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function nearestFraction(point: Vec2, [a, b]: SheetEdge) {
  const lengthSquared = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return lengthSquared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / lengthSquared)) : 0;
}

// Clip the actual segments, not their bounding boxes: a part's centre may be
// outside the detail viewport while its visible edge still needs a callout.
function clipEdge(edge: SheetEdge, bounds: Bounds): SheetEdge | undefined {
  const [a, b] = edge;
  let start = 0, end = 1;
  for (const axis of [0, 1] as const) {
    const low = axis === 0 ? bounds.x : bounds.y;
    const high = low + (axis === 0 ? bounds.width : bounds.height);
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < low || a[axis] > high) return undefined;
    } else {
      const t1 = (low - a[axis]) / delta, t2 = (high - a[axis]) / delta;
      start = Math.max(start, Math.min(t1, t2));
      end = Math.min(end, Math.max(t1, t2));
      if (end < start) return undefined;
    }
  }
  return [interpolate(a, b, start), interpolate(a, b, end)];
}

function crosses([a, b]: SheetEdge, [c, d]: SheetEdge) {
  const cross = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < -1e-6 && cross(c, d, a) * cross(c, d, b) < -1e-6;
}

function onSegment(point: Vec2, edge: SheetEdge) {
  return distance(point, interpolate(...edge, nearestFraction(point, edge))) < 0.2;
}

function touches([a, b]: SheetEdge, [c, d]: SheetEdge) {
  return crosses([a, b], [c, d]) || onSegment(a, [c, d]) || onSegment(b, [c, d]) || onSegment(c, [a, b]) || onSegment(d, [a, b]);
}

function segmentDistance(first: SheetEdge, second: SheetEdge) {
  if (touches(first, second)) return 0;
  return Math.min(
    distance(first[0], interpolate(...second, nearestFraction(first[0], second))),
    distance(first[1], interpolate(...second, nearestFraction(first[1], second))),
    distance(second[0], interpolate(...first, nearestFraction(second[0], first))),
    distance(second[1], interpolate(...first, nearestFraction(second[1], first))),
  );
}

// Every leader ends on an edge belonging to its own component, preferring a
// visible one. A fully occluded part can still keep its callout by falling
// back to hidden edges, even when the clean renderer omits those edges.
// All annotation spacing is in sheet units, so zoom/export cannot detach a tip.
export function figureLabels(view: ReturnType<typeof createFigure>) {
  const visible = view.parts.map(part => ({
    part,
    edges: (part.edges.length ? part.edges : part.hiddenEdges).flatMap(edge => {
      const clipped = clipEdge(edge, view.sourceBounds);
      if (!clipped) return [];
      const sheet = clipped.map(view.toSheet) as unknown as SheetEdge;
      return distance(...sheet) > 1e-6 ? [sheet] : [];
    }),
  })).filter(item => item.edges.length);
  const byX = [...visible].sort((a, b) => a.part.anchor[0] - b.part.anchor[0] || a.part.source.id - b.part.source.id);
  const halves = [byX.slice(0, Math.ceil(byX.length / 2)), byX.slice(Math.ceil(byX.length / 2))];
  const labels = halves.flatMap((items, side) => items.map(item => {
    const { part, edges } = item;
    // Fixed page gutters make compact concentric assemblies look sparse and
    // force callouts to cross the figure. Place each label just outside the
    // projected silhouette, constrained by the page margins.
    const sourceLeft = view.toSheet([view.sourceBounds.x, 0])[0];
    const sourceRight = view.toSheet([view.sourceBounds.x + view.sourceBounds.width, 0])[0];
    const labelGap = 36;
    const sideX = side
      ? Math.min(SVG_FRAME.width - PATENT_DRAWING_STYLE.labelGutter, sourceRight + labelGap)
      : Math.max(PATENT_DRAWING_STYLE.labelGutter, sourceLeft - labelGap);
    const position: Vec2 = [sideX, view.toSheet(part.anchor)[1]];
    const text = part.source.referenceNo || part.source.componentId || String(part.source.id);
    const inset = text.length * 18 * 0.6 / 2 + 7;
    return { id: part.source.id, componentId: part.source.componentId, referenceNo: part.source.referenceNo, edges, side,
      anchor: edges[0][0], position, leaderStart: [position[0] + (side ? -inset : inset), position[1]] as Vec2 };
  }));

  function chooseAnchor(label: typeof labels[number], avoidOthers: boolean): Vec2 {
    const candidates = label.edges.flatMap(edge => {
      const fraction = Math.max(0.15, Math.min(0.85, nearestFraction(label.leaderStart, edge)));
      return [0.25, 0.5, 0.75, fraction].map(t => {
        const point = interpolate(...edge, t);
        return { point, score: distance(label.leaderStart, point) + Math.abs(point[1] - label.position[1]) * 0.7 };
      });
    }).sort((a, b) => a.score - b.score);
    const seen = new Set<string>();
    const shortlist = candidates.filter(({ point }) => {
      const key = point.map(value => value.toFixed(3)).join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 64);
    const others = labels.filter(other => other !== label);
    let best = shortlist[0].point, bestScore = Infinity;
    for (const { point, score } of shortlist) {
      let cost = score;
      for (const other of others) {
        // Shared outlines and crossings do not unambiguously identify a part.
        const clearance = Math.min(...other.edges.map(edge => distance(point, interpolate(...edge, nearestFraction(point, edge)))));
        cost += Math.max(0, 4 - clearance) * 250;
        const leader = [label.leaderStart, point] as SheetEdge;
        const leaderClearance = Math.min(...other.edges.map(edge => segmentDistance(leader, edge)));
        cost += Math.max(0, 3 - leaderClearance) * 600;
        if (other.edges.some(edge => touches(leader, edge))) cost += 12000;
        if (avoidOthers) {
          cost += Math.max(0, 18 - distance(point, other.anchor)) * 80;
          if (crosses([label.leaderStart, point], [other.leaderStart, other.anchor])) cost += 300;
        }
      }
      const leader = [label.leaderStart, point] as SheetEdge;
      cost += label.edges.filter(edge => {
        if (distance(point, interpolate(...edge, nearestFraction(point, edge))) < 0.2) return false;
        return touches(leader, edge);
      }).length * 12000;
      if (cost < bestScore) { best = point; bestScore = cost; }
    }
    return best;
  }

  function spaceLabels() {
    for (const side of [0, 1]) {
      const sorted = labels.filter(label => label.side === side).sort((a, b) => a.anchor[1] - b.anchor[1] || a.id - b.id);
      const top = PATENT_DRAWING_STYLE.drawingArea.y + 16;
      const bottom = PATENT_DRAWING_STYLE.labelBottom;
      const gap = Math.min(30, (bottom - top) / Math.max(1, sorted.length - 1));
      const ys = sorted.map(label => Math.max(top, Math.min(bottom, label.anchor[1])));
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + gap);
      if (ys.length) ys[ys.length - 1] = Math.min(bottom, ys[ys.length - 1]);
      for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - gap);
      sorted.forEach((label, i) => {
        label.position = [label.position[0], ys[i]];
        label.leaderStart = [label.leaderStart[0], ys[i]];
      });
    }
  }

  labels.forEach(label => { label.anchor = chooseAnchor(label, false); });
  for (let pass = 0; pass < 2; pass++) {
    spaceLabels();
    labels.forEach(label => { label.anchor = chooseAnchor(label, true); });
  }
  return labels.map(({ id, componentId, referenceNo, anchor, position, leaderStart }) => ({ id, componentId, referenceNo, anchor, position, leaderStart }));
}
