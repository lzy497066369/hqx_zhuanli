// 把 FreeCAD 输出的三角网格投影成专利说明书附图的二维线稿（隐藏线消除）。
// 纯函数、无外部依赖：可以在没有 FreeCAD 的机器上用固定网格做确定性测试。
import { createHash } from 'node:crypto';

export type Vec3 = [number, number, number];
/** parts[i] 是第 i 个三角面所属的部件编号；有了它，投影时能精确知道每个像素属于哪个部件。 */
export type Mesh = { vertices: Vec3[]; triangles: [number, number, number][]; parts?: string[] };
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
  return hash.digest('hex');
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 | undefined => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 1e-9 ? [a[0] / length, a[1] / length, a[2] / length] : undefined;
};

export type FigureLabel = { text: string; point: Vec3 };
export type KeyCircle = { point: Vec3; radius: number };
export type ProjectionOptions = {
  direction: Vec3; up?: Vec3; width?: number; height?: number; margin?: number; label?: string;
  /** 显式锚点标号（数字放在轮廓外侧留白处，细弧形引出线落到锚点吸附的可见顶点）。 */
  labels?: FigureLabel[];
  /** 按网格的 parts 自动标号：引出线落在该部件在本视角可见区域的中心，被完全遮住的部件不标。 */
  partLabels?: boolean;
  /** 无视面积阈值也要标出的部件（用于保证每个部件至少在一张图里出现）。 */
  forceLabelParts?: string[];
  /** 关键结构圈选：细实线圆圈叠加在结构上，并以引出线连接字母 A。 */
  keyCircle?: KeyCircle;
};
export type ProjectionResult = { svg: string; width: number; height: number; visibleSegments: number; featureEdges: number; labelCount: number; labelledParts: string[]; partAreas: Record<string, number> };
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
  const bounds = screen.reduce((box, point) => [
    Math.min(box[0], point[0]), Math.min(box[1], point[1]), Math.max(box[2], point[0]), Math.max(box[3], point[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  const spanX = bounds[2] - bounds[0], spanY = bounds[3] - bounds[1];
  const usableX = width - margin * 2, usableY = height - margin * 2;
  if (!(spanX > 1e-6) || !(spanY > 1e-6)) throw new Error('模型在所选视角下没有可投影的尺寸。');
  const scale = Math.min(usableX / spanX, usableY / spanY);
  const offsetX = margin + (usableX - spanX * scale) / 2, offsetY = margin + (usableY - spanY * scale) / 2;
  const toPixel = (point: Vec3): [number, number] => [offsetX + (point[0] - bounds[0]) * scale, height - (offsetY + (point[1] - bounds[1]) * scale)];

  const triangles = mesh.triangles.slice(0, MAX_RENDER_TRIANGLES);
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
    if (features.length >= MAX_FEATURE_EDGES) break;
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
    const minX = Math.max(0, Math.floor(Math.min(rasterized[0][0], rasterized[1][0], rasterized[2][0])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(rasterized[0][0], rasterized[1][0], rasterized[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(rasterized[0][1], rasterized[1][1], rasterized[2][1])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(rasterized[0][1], rasterized[1][1], rasterized[2][1])));
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

  const paths: string[] = [];
  let visibleSegments = 0;
  for (const edge of edges) {
    const from = toPixel(screen[edge.a]), to = toPixel(screen[edge.b]);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < 1.2) continue;
    const steps = Math.min(Math.ceil(length), 4000);
    const depthFrom = screen[edge.a][2], depthTo = screen[edge.b][2];
    const format = (x: number, y: number) => `${(Math.round(x * 10) / 10).toFixed(1)} ${(Math.round(y * 10) / 10).toFixed(1)}`;
    let command = '';
    let runStart: [number, number] | null = null, runEnd: [number, number] | null = null;
    const minimumRun = Math.min(4, length * .6);
    const flush = () => {
      // 隐藏边在轮廓顶点附近会有几个像素的深度几乎相等，产生短残段；按边长比例过滤，不误删曲面细分出的短弧段。
      if (runStart && runEnd && Math.hypot(runEnd[0] - runStart[0], runEnd[1] - runStart[1]) >= minimumRun) { command += `M ${format(runStart[0], runStart[1])} L ${format(runEnd[0], runEnd[1])}`; visibleSegments += 1; }
      runStart = null; runEnd = null;
    };
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps;
      const x = from[0] + (to[0] - from[0]) * ratio, y = from[1] + (to[1] - from[1]) * ratio;
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
  const fontSize = Math.round(Math.min(width, height) * 0.034);
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
    const [dx, dy] = direction ?? chooseDirection(anchor, own);
    const reach = exitDistance(anchor, dx, dy) + margin * .45;
    const pad = fontSize;
    let lx = Math.min(width - pad, Math.max(pad, anchor[0] + dx * reach));
    let ly = Math.min(height - pad * .6, Math.max(pad, anchor[1] + dy * reach));
    for (let guard = 0; guard < 12 && placed.some(point => Math.hypot(point[0] - lx, point[1] - ly) < fontSize * 1.6); guard++) {
      if (Math.abs(dx) > Math.abs(dy)) ly += fontSize * 1.6 * (dy >= 0 ? 1 : -1); else lx += fontSize * 1.6 * (dx >= 0 ? 1 : -1);
      lx = Math.min(width - pad, Math.max(pad, lx)); ly = Math.min(height - pad * .6, Math.max(pad, ly));
    }
    placed.push([lx, ly]);
    const ex = lx - dx * fontSize * .55, ey = ly - dy * fontSize * .55;
    const mx = (anchor[0] + ex) / 2, my = (anchor[1] + ey) / 2;
    const px = -(ey - anchor[1]), py = ex - anchor[0];
    const pl = Math.hypot(px, py) || 1;
    const bend = Math.hypot(ex - anchor[0], ey - anchor[1]) * .18;
    const cx = mx + px / pl * bend, cy = my + py / pl * bend;
    const f = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
    annotations.push(`<path d="M ${f(anchor[0])} ${f(anchor[1])} Q ${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}"/>`,
      `<text x="${f(lx)}" y="${f(ly + fontSize * .35)}">${escapeXml(text)}</text>`);
  };
  let labelCount = 0;
  const labelledParts: string[] = [];
  const partAreas: Record<string, number> = {};
  for (const item of options.labels || []) {
    place(item.text, toPixel(snap(item.point)));
    labelCount += 1;
  }
  if (options.partLabels && owner) {
    // 每个部件在 8 个方向上最靠外的可见像素：引出线从部件外侧边缘出发，短而直接，尽量不穿过别的部件。
    const counts = partIds.map(() => 0);
    const extremes = partIds.map(() => DIRECTIONS.map(() => ({ x: 0, y: 0, score: -Infinity })));
    for (let at = 0; at < owner.length; at++) {
      const id = owner[at];
      if (!id) continue;
      const x = at % width, y = Math.floor(at / width);
      counts[id - 1] += 1;
      const slots = extremes[id - 1];
      for (const [index, [dx, dy]] of DIRECTIONS.entries()) {
        const score = x * dx + y * dy;
        if (score > slots[index].score) slots[index] = { x, y, score };
      }
    }
    for (const [index, id] of partIds.entries()) partAreas[id] = counts[index];
    // 小零件（销轴、铰链）也要能标：阈值降到约 0.15 个字高面积；forceLabelParts 里的部件只要可见就标。
    const minimumArea = fontSize * fontSize * .15;
    const forced = new Set(options.forceLabelParts || []);
    for (const [index, id] of partIds.entries()) {
      if (!counts[index] || (counts[index] < minimumArea && !forced.has(id))) continue;
      let best: { anchor: [number, number]; direction: [number, number]; cost: number } | undefined;
      for (const [slot, direction] of DIRECTIONS.entries()) {
        const extreme = extremes[index][slot];
        // 落点从边缘往部件内收 2 像素，保证线头落在部件上而不是悬在轮廓外。
        const anchor: [number, number] = [extreme.x + .5 - direction[0] * 2, extreme.y + .5 - direction[1] * 2];
        const cost = directionCost(anchor, direction[0], direction[1], index + 1);
        if (!best || cost < best.cost) best = { anchor, direction, cost };
      }
      place(id, best!.anchor, best!.direction, index + 1);
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>` +
    `<g fill="none" stroke="#000000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="8">` +
    paths.map(path => `<path d="${path}"/>`).join('') + '</g>' +
    (annotations.length ? `<g fill="none" stroke="#000000" stroke-width="1.2" stroke-linecap="round" font-family="'Times New Roman', 'SimSun', serif" font-size="${fontSize}" text-anchor="middle">` +
      annotations.map(item => item.startsWith('<text') ? item.replace('<text ', '<text fill="#000000" stroke="none" ') : item).join('') + '</g>' : '') +
    '</svg>';
  return { svg, width, height, visibleSegments, featureEdges: edges.length, labelCount, labelledParts, partAreas };
}
