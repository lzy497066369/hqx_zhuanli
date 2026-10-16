// 把 FreeCAD 输出的三角网格投影成专利说明书附图的二维线稿（隐藏线消除）。
// 纯函数、无外部依赖：可以在没有 FreeCAD 的机器上用固定网格做确定性测试。
import { createHash } from 'node:crypto';
import type { DrawingAnnotation, DrawingSurfaceText, DrawingDimension } from '../src/features/product/productDrawing.ts';

export type Vec3 = [number, number, number];
/** parts[i] 是第 i 个三角面所属的部件编号；有了它，投影时能精确知道每个像素属于哪个部件。 */
export type Mesh = { vertices: Vec3[]; triangles: [number, number, number][]; parts?: string[]; sectionFaces?: boolean[]; instances?: string[] };
export const MAX_MESH_VERTICES = 400000;
export const MAX_MESH_TRIANGLES = 200000;
const MAX_RENDER_TRIANGLES = 120000;
const MAX_FEATURE_EDGES = 80000;
const CREASE_COS = Math.cos(12 * Math.PI / 180);

const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
const triple = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(numeric);

export function isMesh(value: unknown): value is Mesh {
  if (!value || typeof value !== 'object') return false;
  const mesh = value as Mesh;
  if (!Array.isArray(mesh.vertices) || !mesh.vertices.length || mesh.vertices.length > MAX_MESH_VERTICES || !mesh.vertices.every(triple)) return false;
  if (!Array.isArray(mesh.triangles) || !mesh.triangles.length || mesh.triangles.length > MAX_MESH_TRIANGLES) return false;
  if (mesh.parts !== undefined && (!Array.isArray(mesh.parts) || mesh.parts.length !== mesh.triangles.length || !mesh.parts.every(part => typeof part === 'string' && /^\d{1,3}$/.test(part)))) return false;
  if (mesh.sectionFaces !== undefined && (!Array.isArray(mesh.sectionFaces) || mesh.sectionFaces.length !== mesh.triangles.length || !mesh.sectionFaces.every(v => typeof v === 'boolean'))) return false;
  if (mesh.instances !== undefined && (!mesh.parts || !Array.isArray(mesh.instances) || mesh.instances.length !== mesh.triangles.length || !mesh.instances.every((v,i) => typeof v === 'string' && /^\d{1,3}-[1-9]\d{0,2}$/.test(v) && v.split('-')[0] === mesh.parts![i]))) return false;
  return mesh.triangles.every(triangle => Array.isArray(triangle) && triangle.length === 3 && triangle.every(index =>
    Number.isSafeInteger(index) && index >= 0 && index < mesh.vertices.length) && new Set(triangle).size === 3);
}
/** 网格摘要参与签名：附图必须对应同一份模型数据。 */
export function meshDigest(mesh: Mesh): string {
  const hash = createHash('sha256');
  for (const vertex of mesh.vertices) hash.update(vertex.map(value => value.toFixed(4)).join(','));
  hash.update('|');
  for (const triangle of mesh.triangles) hash.update(triangle.join(','));
  if (mesh.parts) { hash.update('|'); hash.update(mesh.parts.join(',')); }
  if (mesh.instances) { hash.update('|instances:'); hash.update(mesh.instances.join(',')); }
  if (mesh.sectionFaces) { hash.update('|sections:'); hash.update(mesh.sectionFaces.map(v=>v?'1':'0').join('')); }
  return hash.digest('hex');
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 | undefined => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 1e-9 ? [a[0] / length, a[1] / length, a[2] / length] : undefined;
};

export type FigureLabel = { text: string; point: Vec3; owner?: string };
export type KeyCircle = { point: Vec3; radius: number };
export type ProjectionOptions = {
  externalLabels?: boolean;
  surfaceTexts?: DrawingSurfaceText[];
  dimensions?: DrawingDimension[];
  direction: Vec3; up?: Vec3; requiredLabels?: string[]; width?: number; height?: number; margin?: number; label?: string;
  focus?: { point: Vec3; radius: number };
  /** 显式锚点标号（数字放在轮廓外侧留白处，细弧形引出线落到锚点吸附的可见顶点）。 */
  labels?: FigureLabel[];
  /** 按网格的 parts 自动标号：引出线落在该部件在本视角可见区域的中心，被完全遮住的部件不标。 */
  partLabels?: boolean;
  /** 无视面积阈值也要标出的部件（用于保证每个部件至少在一张图里出现）。 */
  forceLabelParts?: string[];
  /** 关键结构圈选：细实线圆圈叠加在结构上，并以引出线连接字母 A。 */
  keyCircle?: KeyCircle;
};
export type ProjectionResult = { annotations: DrawingAnnotation[]; svg: string; width: number; height: number; visibleSegments: number; featureEdges: number; labelCount: number; labelledParts: string[]; partAreas: Record<string, number> };
const escapeXml = (text: string) => text.replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[character]!);

/** 正交投影 + 深度缓冲隐藏线消除；同一份网格的不同视角共用这一个实现。 */
export function renderMeshView(mesh: Mesh, options: ProjectionOptions): ProjectionResult {
  const width = Math.round(options.width ?? 1400);
  const height = Math.round(options.height ?? 1000);
  const annotated = !!(options.labels?.length || options.keyCircle || (options.partLabels && mesh.parts));
  const margin = Math.round(options.margin ?? (annotated ? 150 : 70));
  if (width < 200 || width > 6000 || height < 200 || height > 6000) throw new Error('附图画布尺寸超出范围。');
  const view = unit(options.direction);
  if (!view) throw new Error('附图视角方向无效。');
  const preferred = options.up ?? [0, 0, 1];
  let right = unit(cross(preferred, view));
  if (!right) right = unit(cross([0, 1, 0], view));
  if (!right) throw new Error('附图视角方向与基准方向平行。');
  const up = cross(view, right);

  const screen = mesh.vertices.map(vertex => [dot(vertex, right), dot(vertex, up), dot(vertex, view)] as Vec3);
  let bounds = screen.reduce((box, point) => [
    Math.min(box[0], point[0]), Math.min(box[1], point[1]), Math.max(box[2], point[0]), Math.max(box[3], point[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  if (options.focus) {
    const { point, radius } = options.focus;
    if (!triple(point) || !Number.isFinite(radius) || radius <= 0) throw new Error('局部放大范围无效。');
    bounds = [dot(point, right)-radius, dot(point, up)-radius, dot(point, right)+radius, dot(point, up)+radius];
  }
  const spanX = bounds[2] - bounds[0], spanY = bounds[3] - bounds[1];
  const usableX = width - margin * 2, usableY = height - margin * 2;
  if (!(spanX > 1e-6) || !(spanY > 1e-6)) throw new Error('模型在所选视角下没有可投影的尺寸。');
  const scale = Math.min(usableX / spanX, usableY / spanY);
  const offsetX = margin + (usableX - spanX * scale) / 2, offsetY = margin + (usableY - spanY * scale) / 2;
  const toPixel = (point: Vec3): [number, number] => [offsetX + (point[0] - bounds[0]) * scale, height - (offsetY + (point[1] - bounds[1]) * scale)];

  if (mesh.triangles.length > MAX_RENDER_TRIANGLES) throw new Error('网格超过投影上限，不能截断模型后出图。');
  const triangles = mesh.triangles;
  const normals: (Vec3 | undefined)[] = triangles.map(triangle => unit(cross(sub(mesh.vertices[triangle[1]], mesh.vertices[triangle[0]]), sub(mesh.vertices[triangle[2]], mesh.vertices[triangle[0]]))));
  const edgeFaces = new Map<string, number[]>();
  for (const [index, triangle] of triangles.entries()) {
    for (let corner = 0; corner < 3; corner++) {
      const a = triangle[corner], b = triangle[(corner + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const faces = edgeFaces.get(key);
      if (faces) { if (faces.length < 2) faces.push(index); } else edgeFaces.set(key, [index]);
    }
  }
  const features: { a: number; b: number }[] = [];
  for (const [key, faces] of edgeFaces) {
    const [a, b] = key.split('_').map(Number);
    if (faces.length === 1) { features.push({ a, b }); continue; }
    const first = normals[faces[0]], second = normals[faces[1]];
    if (!first || !second) continue;
    // 折边（相邻面夹角大）与轮廓线（相邻面朝向相反）才是真正的结构轮廓，去掉平面上的三角对角线。
    // 恰好与视线平行的细分面单独算一类，否则圆柱在正视图里的两条侧轮廓会被漏掉。
    const facing = (value: number) => value > 1e-6 ? 1 : value < -1e-6 ? -1 : 0;
    const crease = dot(first, second) < CREASE_COS;
    const silhouette = facing(dot(first, view)) !== facing(dot(second, view));
    if (crease || silhouette) features.push({ a, b });
    if (features.length >= MAX_FEATURE_EDGES) throw new Error('轮廓过于复杂，不能截断附图。');
  }
  const edges = features.length ? features : [...edgeFaces.keys()].map(key => { const [a, b] = key.split('_').map(Number); return { a, b }; });

  const diagonal = Math.hypot(spanX, spanY) || 1;
  const bias = Math.max(diagonal * 0.004, 0.05);
  const looseBias = Math.max(diagonal * 0.03, 0.5);
  const depth = new Float32Array(width * height).fill(-Infinity);
  // 部件编号缓冲：与深度缓冲同步更新，记录每个像素最前面的三角面属于哪个部件（索引 +1，0 为背景）。
  const partIds = mesh.parts ? [...new Set(mesh.parts)].sort((a, b) => Number(a) - Number(b)) : [];
  const partIndex = new Map(partIds.map((id, index) => [id, index + 1]));
  const owner = partIds.length ? new Int16Array(width * height) : undefined;
  for (const [triangleIndex, triangle] of triangles.entries()) {
    const ownerId = owner ? partIndex.get(mesh.parts![triangleIndex]) ?? 0 : 0;
    const rasterized = triangle.map(index => { const pixel = toPixel(screen[index]); return [pixel[0], pixel[1], screen[index][2]] as Vec3; });
    const minX = Math.max(options.focus ? Math.ceil(offsetX) : 0, Math.floor(Math.min(rasterized[0][0], rasterized[1][0], rasterized[2][0])));
    const maxX = Math.min(options.focus ? Math.floor(offsetX+spanX*scale) : width - 1, Math.ceil(Math.max(rasterized[0][0], rasterized[1][0], rasterized[2][0])));
    const minY = Math.max(options.focus ? Math.ceil(height-offsetY-spanY*scale) : 0, Math.floor(Math.min(rasterized[0][1], rasterized[1][1], rasterized[2][1])));
    const maxY = Math.min(options.focus ? Math.floor(height-offsetY) : height - 1, Math.ceil(Math.max(rasterized[0][1], rasterized[1][1], rasterized[2][1])));
    if (maxX < minX || maxY < minY) continue;
    const area = (rasterized[1][0] - rasterized[0][0]) * (rasterized[2][1] - rasterized[0][1]) - (rasterized[2][0] - rasterized[0][0]) * (rasterized[1][1] - rasterized[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + .5, py = y + .5;
        const w0 = ((rasterized[1][0] - px) * (rasterized[2][1] - py) - (rasterized[2][0] - px) * (rasterized[1][1] - py)) / area;
        const w1 = ((rasterized[2][0] - px) * (rasterized[0][1] - py) - (rasterized[0][0] - px) * (rasterized[2][1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const value = w0 * rasterized[0][2] + w1 * rasterized[1][2] + w2 * rasterized[2][2];
        const at = y * width + x;
        if (value > depth[at]) { depth[at] = value; if (owner) owner[at] = ownerId; }
      }
    }
  }

  const contour = options.focus && options.partLabels ? new Uint8Array(width * height) : undefined;
  const paths: string[] = [];
  let visibleSegments = 0;
  for (const edge of edges) {
    const from = toPixel(screen[edge.a]), to = toPixel(screen[edge.b]);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < .08) continue;
    const steps = Math.min(Math.max(2, Math.ceil(length * 2)), 8000);
    const depthFrom = screen[edge.a][2], depthTo = screen[edge.b][2];
    const format = (x: number, y: number) => `${(Math.round(x * 10) / 10).toFixed(1)} ${(Math.round(y * 10) / 10).toFixed(1)}`;
    let command = '';
    let runStart: [number, number] | null = null, runEnd: [number, number] | null = null;
    const minimumRun = length < 4 ? length * .25 : Math.min(4, length * .6);
    const flush = () => {
      // 隐藏边在轮廓顶点附近会有几个像素的深度几乎相等，产生短残段；按边长比例过滤，不误删曲面细分出的短弧段。
      if (runStart && runEnd && Math.hypot(runEnd[0] - runStart[0], runEnd[1] - runStart[1]) >= minimumRun) { command += `M ${format(runStart[0], runStart[1])} L ${format(runEnd[0], runEnd[1])}`; visibleSegments += 1;
        if (contour) {
          const steps=Math.max(1,Math.ceil(Math.hypot(runEnd[0]-runStart[0],runEnd[1]-runStart[1])*2));
          for(let k=0;k<=steps;k++) {
            const x=Math.floor(runStart[0]+(runEnd[0]-runStart[0])*k/steps), y=Math.floor(runStart[1]+(runEnd[1]-runStart[1])*k/steps);
            for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height) contour[(y+dy)*width+x+dx]=1;
          }
        }
      }
      runStart = null; runEnd = null;
    };
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps;
      const x = from[0] + (to[0] - from[0]) * ratio, y = from[1] + (to[1] - from[1]) * ratio;
      if (options.focus && (x < offsetX || x > offsetX+spanX*scale || y < height-offsetY-spanY*scale || y > height-offsetY)) { flush(); continue; }
      const px = Math.min(width - 1, Math.max(0, Math.floor(x))), py = Math.min(height - 1, Math.max(0, Math.floor(y)));
      // 轮廓线恰好落在自身表面上，单像素深度会因采样误差误判为被遮挡；取 3×3 邻域里有物体像素中最远的深度做比较，
      // 背景像素（无物体）不参与，否则背面的边会借轮廓外侧的空白通过检查。
      let buffer = Infinity, nearest = -Infinity;
      let background = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const value = depth[ny * width + nx];
        if (Number.isFinite(value)) { if (value < buffer) buffer = value; if (value > nearest) nearest = value; } else background = true;
      }
      const sample = depthFrom + (depthTo - depthFrom) * ratio;
      // 曲面轮廓线（圆柱侧边）正好贴着背景，而曲面在轮廓处朝观察者急剧隆起，相邻像素中心已明显更近；
      // 对紧挨背景的边放宽深度容差，但仍足以挡住与前方轮廓重合的远处背面边。
      const visible = !Number.isFinite(buffer) || sample >= buffer - bias || (background && sample >= nearest - looseBias);
      if (!visible) { flush(); continue; }
      // 直线边上的可见段只记录起止点，不逐像素写入路径。
      if (!runStart) runStart = [x, y];
      runEnd = [x, y];
    }
    flush();
    if (command) paths.push(command);
  }
  const label = options.label || '专利附图';
  // ---- 标号与圈选 ----
  const project = (point: Vec3): Vec3 => [dot(point, right), dot(point, up), dot(point, view)];
  const visibleAt = (point: Vec3) => {
    const pixel = toPixel(point);
    const px = Math.min(width - 1, Math.max(0, Math.floor(pixel[0]))), py = Math.min(height - 1, Math.max(0, Math.floor(pixel[1])));
    const buffer = depth[py * width + px];
    return !Number.isFinite(buffer) || point[2] >= buffer - looseBias;
  };
  /** 锚点吸附到附近可见的网格顶点；没有可见顶点时退回最近顶点，再不行就用原点。 */
  const snap = (point: Vec3): Vec3 => {
    const radius = Math.max(diagonal * 0.12, 1);
    let best: { index: number; distance: number; visible: boolean } | undefined;
    for (const [index, vertex] of mesh.vertices.entries()) {
      const distance = Math.hypot(vertex[0] - point[0], vertex[1] - point[1], vertex[2] - point[2]);
      if (distance > radius) continue;
      const visible = visibleAt(screen[index]);
      if (!best || (visible && !best.visible) || (visible === best.visible && distance < best.distance)) best = { index, distance, visible };
    }
    return best ? screen[best.index] : project(point);
  };
  const fx0 = offsetX, fx1 = offsetX + spanX * scale, fy0 = height - (offsetY + spanY * scale), fy1 = height - offsetY;
  const placed: [number, number][] = [];
  const annotations: string[] = [];
  const fontSize = Math.round(Math.min(width, height) * 0.04);
  const annotationRecords: DrawingAnnotation[] = [];
  const exitDistance = (anchor: [number, number], dx: number, dy: number) => {
    const tx = dx > 1e-9 ? (fx1 - anchor[0]) / dx : dx < -1e-9 ? (fx0 - anchor[0]) / dx : Infinity;
    const ty = dy > 1e-9 ? (fy1 - anchor[1]) / dy : dy < -1e-9 ? (fy0 - anchor[1]) / dy : Infinity;
    return Math.max(0, Math.min(tx, ty));
  };
  /** 某个方向的引出线代价：越长、越穿过其他部件、越和已有标号挤在一起，代价越高。 */
  const directionCost = (anchor: [number, number], dx: number, dy: number, own: number) => {
    const reach = exitDistance(anchor, dx, dy) + margin * .45;
    const lx = anchor[0] + dx * reach, ly = anchor[1] + dy * reach;
    const crowding = placed.reduce((sum, point) => sum + Math.max(0, fontSize * 3 - Math.hypot(point[0] - lx, point[1] - ly)), 0);
    const outside = lx < fontSize || ly < fontSize || lx > width - fontSize || ly > height - fontSize ? width : 0;
    let crossing = 0;
    const samples = Math.max(8, Math.min(80, Math.round(reach / 6)));
    for (let index = 1; index <= samples; index++) {
      const sx = Math.floor(anchor[0] + dx * reach * index / samples), sy = Math.floor(anchor[1] + dy * reach * index / samples);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const at = sy * width + sx;
      if (!Number.isFinite(depth[at])) continue;
      if (!owner || owner[at] !== own) crossing += 1;
    }
    return reach + crowding * 2 + outside + crossing * (reach / samples) * 3;
  };
  const DIRECTIONS: [number, number][] = Array.from({ length: 8 }, (_, step) => [Math.cos(step * Math.PI / 4), Math.sin(step * Math.PI / 4)]);
  /** 在 8 个方向里选引出线最短、尽量不穿过其他部件、且不和已有标号挤在一起的一侧，数字落在轮廓外侧留白处。 */
  const chooseDirection = (anchor: [number, number], own = 0): [number, number] => {
    let best: { direction: [number, number]; cost: number } | undefined;
    for (const direction of DIRECTIONS) {
      const cost = directionCost(anchor, direction[0], direction[1], own);
      if (!best || cost < best.cost) best = { direction, cost };
    }
    return best!.direction;
  };
  const place = (text: string, anchor: [number, number], direction?: [number, number], own = 0) => {
    const pad = fontSize * Math.max(1.4, text.length * .45);
    const candidates: [number, number][] = [];
    const preferred = direction ?? chooseDirection(anchor, own);
    // Empty space beside the actual contour is usable even inside the overall
    // bounding rectangle. Forcing every number to that rectangle creates very
    // long leaders on frames, rails and other open assemblies.
    for (const distance of [2.8, 4, 6, 8, 11].map(n => n * fontSize)) {
      for (const [dx, dy] of [preferred, ...DIRECTIONS]) candidates.push([anchor[0]+dx*distance, anchor[1]+dy*distance]);
    }
    for (const [dx, dy] of [preferred, ...DIRECTIONS]) {
      const reach = exitDistance(anchor, dx, dy) + margin * .48;
      candidates.push([Math.max(pad, Math.min(width-pad, anchor[0]+dx*reach)), Math.max(pad, Math.min(height-pad, anchor[1]+dy*reach))]);
    }
    // Extra perimeter slots allow dense callouts to remain legible without clamping them on top of each other.
    for (let y = pad; y <= height-pad; y += fontSize*1.8) for (const x of [Math.max(pad, fx0-margin*.5), Math.min(width-pad, fx1+margin*.5)]) candidates.push([x,y]);
    for (let x = pad; x <= width-pad; x += fontSize*2.6) for (const y of [Math.max(pad, fy0-margin*.5), Math.min(height-pad, fy1+margin*.5)]) candidates.push([x,y]);
    const blankLabelBox = (x: number, y: number) => {
      if (x < pad || x > width-pad || y < pad || y > height-pad) return false;
      for (let py=Math.floor(y-fontSize); py<=y+fontSize; py+=2) for (let px=Math.floor(x-pad); px<=x+pad; px+=2) {
        if (Number.isFinite(depth[py*width+px])) return false;
      }
      return true;
    };
    const valid = candidates.filter(([x,y]) => (!options.externalLabels || x+pad<fx0 || x-pad>fx1 || y+fontSize<fy0 || y-fontSize>fy1) && blankLabelBox(x,y) &&
      annotationRecords.every(a => Math.abs(a.position[0]-x) > fontSize*(a.number.length+text.length)*.34+12 || Math.abs(a.position[1]-y) > fontSize*1.65));
    if (!valid.length) throw new Error(`标号${text}无法无重叠排布，请拆分局部附图。`);
    const intersects = (a: number[], b: number[], c: number[], d: number[]) => {
      const cross = (p: number[], q: number[], r: number[]) => (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
      return cross(a,b,c)*cross(a,b,d) < 0 && cross(c,d,a)*cross(c,d,b) < 0;
    };
    const cost = (p: [number, number]) => {
      const length = Math.hypot(p[0]-anchor[0],p[1]-anchor[1]);
      const crossing = annotationRecords.filter(a => intersects(anchor,p,a.anchor,a.position)).length;
      let structureCrossing = 0;
      for (let step=1; step<=80; step++) {
        const x=Math.floor(anchor[0]+(p[0]-anchor[0])*step/80), y=Math.floor(anchor[1]+(p[1]-anchor[1])*step/80);
        if (x>=0 && y>=0 && x<width && y<height && Number.isFinite(depth[y*width+x]) && owner?.[y*width+x] !== own) structureCrossing++;
      }
      return length + crossing*width*2 + structureCrossing*length/80*6;
    };
    valid.sort((a,b) => cost(a)-cost(b));
    const [lx,ly] = valid[0];
    placed.push([lx,ly]);
    const length = Math.hypot(lx-anchor[0],ly-anchor[1]) || 1;
    const ex = lx-(lx-anchor[0])/length*Math.min(fontSize*.65,length*.5), ey = ly-(ly-anchor[1])/length*Math.min(fontSize*.65,length*.5);
    const f = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
    annotations.push(`<path data-mark="${escapeXml(text)}" d="M ${f(anchor[0])} ${f(anchor[1])} L ${f(ex)} ${f(ey)}"/>`,
      `<text x="${f(lx)}" y="${f(ly + fontSize * .35)}">${escapeXml(text)}</text>`);
    annotationRecords.push({ number: text, owner: partIds[own-1] || '', anchor, position: [lx,ly] });
  };
  let labelCount = 0;
  const labelledParts: string[] = [];
  const partAreas: Record<string, number> = {};
  for (const item of options.labels || []) {
    if (options.requiredLabels && !options.requiredLabels.includes(item.text)) continue;
    if (item.owner && owner) {
      // Use only the specified surface point and its owner. Never snap a hole/slot to an unrelated part.
      const projected = project(item.point), pixel = toPixel(projected);
      const px = Math.floor(pixel[0]), py = Math.floor(pixel[1]);
      const own = partIndex.get(item.owner);
      let matched: [number,number] | undefined;
      for (let dy=-2; dy<=2 && !matched; dy++) for (let dx=-2; dx<=2; dx++) {
        const x=px+dx, y=py+dy;
        if (x>=0 && y>=0 && x<width && y<height && owner[y*width+x]===own && Math.abs(projected[2]-depth[y*width+x]) <= bias) { matched=[x+.5,y+.5]; break; }
      }
      if (!matched) continue;
      place(item.text, matched, undefined, own);
      labelledParts.push(item.text);
    } else place(item.text, toPixel(snap(item.point)));
    labelCount += 1;
  }
  if (options.partLabels && owner) {
    // 每个部件在 8 个方向上最靠外的可见像素：引出线从部件外侧边缘出发，短而直接，尽量不穿过别的部件。
    const counts = partIds.map(() => 0);
    const extremes = partIds.map(() => DIRECTIONS.map(() => ({ x: 0, y: 0, score: -Infinity })));
    const clearExtremes = partIds.map(() => DIRECTIONS.map(() => ({ x: 0, y: 0, score: -Infinity })));
    for (let at = 0; at < owner.length; at++) {
      const id = owner[at];
      if (!id) continue;
      const x = at % width, y = Math.floor(at / width);
      counts[id - 1] += 1;
      // Cropping creates a buffer edge, not a physical feature. Choose points
      // near an actual visible contour and away from that artificial boundary.
      if (contour && (!contour[at] || x<fx0+8 || x>fx1-8 || y<fy0+8 || y>fy1-8)) continue;
      const slots = extremes[id - 1];
      for (const [index, [dx, dy]] of DIRECTIONS.entries()) {
        const score = x * dx + y * dy;
        if (score > slots[index].score) slots[index] = { x, y, score };
      }
      // Avoid an endpoint beside another component's silhouette, e.g. labelling
      // a pressure plate at the bolt-head junction. Same-owner pixels alone are
      // insufficient for a reader to distinguish those two parts.
      if (x % 3 === 0 && y % 3 === 0) {
        let clear = true;
        for (const dy of [-6,-3,0,3,6]) for (const dx of [-6,-3,0,3,6]) {
          const sx=x+dx, sy=y+dy;
          if (sx<0 || sy<0 || sx>=width || sy>=height) continue;
          const neighbour=owner[sy*width+sx];
          if (neighbour && neighbour!==id) clear=false;
        }
        if (clear) for (const [index,[dx,dy]] of DIRECTIONS.entries()) {
          const score=x*dx+y*dy;
          if (score>clearExtremes[id-1][index].score) clearExtremes[id-1][index]={x,y,score};
        }
      }
    }
    for (const [index, id] of partIds.entries()) partAreas[id] = counts[index];
    // 小零件（销轴、铰链）也要能标：阈值降到约 0.15 个字高面积；forceLabelParts 里的部件只要可见就标。
    const minimumArea = fontSize * fontSize * .15;
    const forced = new Set(options.forceLabelParts || []);
    for (const [index, id] of partIds.entries()) {
      if (options.requiredLabels && !options.requiredLabels.includes(id)) continue;
      if (!counts[index] || (counts[index] < minimumArea && !forced.has(id))) continue;
      let best: { anchor: [number, number]; direction: [number, number]; cost: number } | undefined;
      for (const [slot, direction] of DIRECTIONS.entries()) {
        const extreme = Number.isFinite(clearExtremes[index][slot].score) ? clearExtremes[index][slot] : extremes[index][slot];
        // 落点从边缘往部件内收 2 像素，保证线头落在部件上而不是悬在轮廓外。
        if (!Number.isFinite(extreme.score)) continue;
        const anchor: [number, number] = [extreme.x + .5, extreme.y + .5];
        const cost = directionCost(anchor, direction[0], direction[1], index + 1);
        if (!best || cost < best.cost) best = { anchor, direction, cost };
      }
      if (!best) continue;
      place(id, best.anchor, best.direction, index + 1);
      labelCount += 1; labelledParts.push(id);
    }
  }
  if (options.keyCircle) {
    const centre = toPixel(project(options.keyCircle.point));
    const radius = Math.max(fontSize * 1.4, options.keyCircle.radius * scale);
    // 圈内必须真的有结构：按圆内采样，实体像素不足两成就不画圈，避免圈住空白或图外。
    let inside = 0, total = 0;
    for (let ring = 0; ring < 6; ring++) for (let step = 0; step < 12; step++) {
      const rr = radius * (ring + .5) / 6, angle = step * Math.PI / 6;
      const sx = Math.floor(centre[0] + Math.cos(angle) * rr), sy = Math.floor(centre[1] + Math.sin(angle) * rr);
      total += 1;
      if (sx >= 0 && sy >= 0 && sx < width && sy < height && Number.isFinite(depth[sy * width + sx])) inside += 1;
    }
    if (inside >= total * .2) {
      const f = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
      annotations.push(`<circle cx="${f(centre[0])}" cy="${f(centre[1])}" r="${f(radius)}"/>`);
      const [dx, dy] = chooseDirection(centre);
      place('A', [centre[0] + dx * radius, centre[1] + dy * radius], [dx, dy]);
      labelCount += 1;
    }
  }
  const dimensionPaths = (options.dimensions || []).map(item => {
    const axis = 'xyz'.indexOf(item.axis), vector: Vec3 = [0,0,0]; vector[axis]=1;
    if (Math.abs(dot(vector,view))>1e-6 || Math.abs(dot(vector,right))>1e-6) throw new Error('间隙尺寸须采用测量轴朝上的正投影视图。');
    const ends=[item.from,item.to].map(p=>{
      const projected=project(p.point), pixel=toPixel(projected), own=partIndex.get(p.owner);
      let visible=false;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++) {
        const x=Math.floor(pixel[0])+dx,y=Math.floor(pixel[1])+dy;
        if(owner && own && x>=0&&x<width&&y>=0&&y<height && owner[y*width+x]===own && Math.abs(projected[2]-depth[y*width+x])<=bias)visible=true;
      }
      if(!visible)throw new Error('间隙尺寸端点未落在对应的可见实体表面。');
      return pixel;
    });
    const value=Math.abs(item.from.point[axis]-item.to.point[axis]);
    if(value<.01 || value*scale<8)throw new Error('间隙尺寸过小，须增加局部放大图。');
    const y0=Math.min(ends[0][1],ends[1][1]), y1=Math.max(ends[0][1],ends[1][1]), x=fx1+35;
    const label=`${Number(value.toFixed(3))} mm`;
    return `<g data-dimension="${label}" stroke="#000" stroke-width="1" fill="none">`+
      ends.map(p=>`<path d="M${p[0]} ${p[1]}H${x+8}"/>`).join('')+
      `<path d="M${x} ${y0-22}V${y0}M${x-3} ${y0-7}L${x} ${y0}L${x+3} ${y0-7}M${x} ${y1+22}V${y1}M${x-3} ${y1+7}L${x} ${y1}L${x+3} ${y1+7}"/>`+
      `<text x="${x+14}" y="${(y0+y1)/2+9}" stroke="none" fill="#000" font-family="'Times New Roman', serif" font-size="28">${label}</text></g>`;
  });
  const surfaceTexts = (options.surfaceTexts || []).map(item => {
    const projected = project(item.point), [x,y] = toPixel(projected), size = Math.max(18, Math.min(80, item.height*scale));
    const own = partIndex.get(item.owner), half = [...item.text].length*size*.5;
    // Text is placed on a face parallel to the picture plane. Verify its whole
    // rectangular footprint belongs to the visible surface, not a hole or air.
    for (let dy=-size; dy<=0; dy+=size/4) for (let dx=-half; dx<=half; dx+=Math.max(1,half/8)) {
      const px=Math.floor(x+dx), py=Math.floor(y+dy);
      if (!owner || !own || px<0 || px>=width || py<0 || py>=height || owner[py*width+px]!==own || Math.abs(projected[2]-depth[py*width+px])>Math.max(.02,diagonal*.0001)) throw new Error(`表面文字“${item.text}”不在完整可见的所属平面，请调整位置或视角。`);
    }
    return `<text data-surface-owner="${item.owner}" x="${x}" y="${y}" fill="#000" font-family="SimSun, 'Noto Serif CJK SC', serif" font-size="${size}" text-anchor="middle">${escapeXml(item.text)}</text>`;
  });
  const sectionIds = new Set<string>();
  const patternNumber = (id: string) => id.split("-").reduce((sum,n)=>sum+Number(n),0);
  const sectionPaths = mesh.sectionFaces ? triangles.flatMap((triangle, i) => {
    if (!mesh.sectionFaces![i] || !normals[i] || dot(normals[i]!, view) <= 1e-5) return [];
    const points = triangle.map(n => toPixel(screen[n]));
    if (options.focus && (points.every(p => p[0]<offsetX) || points.every(p => p[0]>offsetX+spanX*scale) || points.every(p => p[1]<height-offsetY-spanY*scale) || points.every(p => p[1]>height-offsetY))) return [];
    const hatchId = mesh.instances?.[i] || mesh.parts?.[i] || "1"; sectionIds.add(hatchId);
    return [`<polygon points="${points.map(p => p.map(n => Math.round(n*10)/10).join(',')).join(' ')}" fill="url(#section-hatch-${hatchId})"/>`];
  }) : [];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>` +
    (sectionPaths.length ? '<defs>'+[...sectionIds].map(id => `<pattern id="section-hatch-${id}" width="${12+patternNumber(id)%3*4}" height="${12+patternNumber(id)%3*4}" patternUnits="userSpaceOnUse" patternTransform="rotate(${[45,-45,30,-30][patternNumber(id)%4]})"><path d="M0 0V30" stroke="#000" stroke-width=".8"/></pattern>`).join('')+'</defs><g'+(options.focus ? ' clip-path="url(#detail-window)"' : '')+'>'+sectionPaths.join('')+'</g>' : '') +
    (options.focus ? `<defs><clipPath id="detail-window"><rect x="${offsetX}" y="${height-offsetY-spanY*scale}" width="${spanX*scale}" height="${spanY*scale}"/></clipPath></defs>` : '') +
    `<g ${options.focus ? 'clip-path="url(#detail-window)" ' : ''}fill="none" stroke="#000000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="8">` +
    paths.map(path => `<path d="${path}"/>`).join('') + '</g>' +
    (annotations.length ? `<g fill="none" stroke="#000000" stroke-width="1.2" stroke-linecap="round" font-family="'Times New Roman', 'SimSun', serif" font-size="${fontSize}" text-anchor="middle">` +
      annotations.map(item => item.startsWith('<text') ? item.replace('<text ', '<text fill="#000000" stroke="none" ') : item).join('') + '</g>' : '') +
    surfaceTexts.join('') + dimensionPaths.join('') + '</svg>';
  return { annotations: annotationRecords, svg, width, height, visibleSegments, featureEdges: edges.length, labelCount, labelledParts, partAreas };
}
