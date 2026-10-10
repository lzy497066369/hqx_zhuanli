import type { PatentGeometry } from './patentStructure.ts';

export type AssemblyIssue = {
  code: string;
  message: string;
  recommendation: string;
  components: string[];
  relation?: string;
  severity: 'error' | 'warning';
};
export type AssemblyInput = {
  title: string;
  components: { name: string; geometry?: PatentGeometry }[];
  relationships: { from: string; to: string; relation: string }[];
};
type Vec = [number, number, number];
type Box = { name: string; center: Vec; axes: [Vec, Vec, Vec]; half: Vec; geometry: PatentGeometry };
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const rotate = (point: Vec, angles: Vec): Vec => {
  let [x, y, z] = point;
  const [a, b, c] = angles.map(angle => angle * Math.PI / 180);
  [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
  [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
  return [x, y, z];
};
const boxOf = (name: string, geometry: PatentGeometry): Box => {
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => rotate(axis as Vec, geometry.rotation)) as [Vec, Vec, Vec];
  const half = geometry.size.map(value => value / 2) as Vec;
  const localCenter = rotate(half, geometry.rotation);
  return { name, geometry, axes, half, center: geometry.position.map((value, axis) => value + localCenter[axis]) as Vec };
};

// Separating-axis distance: a positive result proves the boxes have a gap;
// overlapping bounding boxes alone cannot establish contact for rotated parts.
function boxGap(a: Box, b: Box): number {
  const axes = [...a.axes, ...b.axes, ...a.axes.flatMap(first => b.axes.map(second => cross(first, second)))];
  let separation = 0;
  for (const axis of axes) {
    const length = Math.hypot(...axis);
    if (length < 1e-8) continue;
    const direction = axis.map(value => value / length) as Vec;
    const radius = (box: Box) => box.axes.reduce((sum, basis, i) => sum + box.half[i] * Math.abs(dot(direction, basis)), 0);
    separation = Math.max(separation, Math.abs(dot(sub(a.center, b.center), direction)) - radius(a) - radius(b));
  }
  return separation;
}

// The minimum projection overlap is positive only when the two boxes occupy
// the same volume on every separating axis. It distinguishes real penetration
// from a valid face-to-face contact, which has an overlap close to zero.
function boxPenetration(a: Box, b: Box): number {
  const axes = [...a.axes, ...b.axes, ...a.axes.flatMap(first => b.axes.map(second => cross(first, second)))];
  let penetration = Number.POSITIVE_INFINITY;
  for (const axis of axes) {
    const length = Math.hypot(...axis);
    if (length < 1e-8) continue;
    const direction = axis.map(value => value / length) as Vec;
    const radius = (box: Box) => box.axes.reduce((sum, basis, i) => sum + box.half[i] * Math.abs(dot(direction, basis)), 0);
    penetration = Math.min(penetration, radius(a) + radius(b) - Math.abs(dot(sub(a.center, b.center), direction)));
  }
  return penetration;
}

export function assemblyGeometryIssues(skeleton: AssemblyInput): AssemblyIssue[] {
  const boxes = new Map(skeleton.components.filter(item => item.geometry?.shape === 'box')
    .map(item => [item.name, boxOf(item.name, item.geometry!)]));
  const issues: AssemblyIssue[] = [];
  for (const relation of skeleton.relationships) {
    if (!['fixed_to', 'connected_to', 'supported_by'].includes(relation.relation)) continue;
    const a = boxes.get(relation.from), b = boxes.get(relation.to);
    if (!a || !b) continue;
    const tolerance = Math.max(0.05, Math.min(...a.geometry.size, ...b.geometry.size) * 0.01);
    const gap = boxGap(a, b);
    if (gap > tolerance) issues.push({
      code: 'disconnected_boxes', components: [a.name, b.name], relation: relation.relation,
      severity: relation.relation === 'fixed_to' ? 'error' : 'warning',
      message: `“${a.name}”与“${b.name}”声明相连，但长方体至少相隔 ${gap.toFixed(2)} 个示意单位；请核对位置、尺寸及旋转。`,
      recommendation: relation.relation === 'fixed_to'
        ? '若两者直接固定，请让真实安装面接触；若实际通过边框、底座或转轴座连接，请补充中间部件并重建连接关系；若该间隔符合实物，不应使用 fixed_to。'
        : '请确认这是实际安装间隔，或核对是否遗漏了边框、底座、转轴座等中间部件。',
    });
    const penetration = boxPenetration(a, b);
    // Tiny corner overlaps are common after rotating a box about its local
    // origin and are not reliable evidence of an actual assembly error.
    const penetrationTolerance = Math.max(tolerance, Math.min(...a.geometry.size, ...b.geometry.size) * 0.1);
    if (gap <= tolerance && penetration > penetrationTolerance) issues.push({
      code: 'intersecting_boxes', components: [a.name, b.name], relation: relation.relation,
      severity: relation.relation === 'fixed_to' ? 'error' : 'warning',
      message: `“${a.name}”与“${b.name}”声明相连，但两个长方体相互穿插约 ${penetration.toFixed(2)} 个示意单位；请核对位置、尺寸及旋转。`,
      recommendation: '调整安装面、尺寸或旋转，避免一个部件进入另一个部件内部；只有实际存在套接、嵌入或重叠结构时，才保留该几何并改用准确的连接说明。',
    });
  }

  // Only apply the profile contract when the title and all three named parts
  // unambiguously describe a three-plate H section. Other beams may differ.
  if (!/H[型形]钢|H形截面|截面呈H形/iu.test(skeleton.title)) return issues;
  const parts = skeleton.components;
  const lower = parts.filter(item => /下(?:翼缘|翼板)/u.test(item.name));
  const upper = parts.filter(item => /上(?:翼缘|翼板)/u.test(item.name));
  const webs = parts.filter(item => /腹板/u.test(item.name));
  if (lower.length !== 1 || upper.length !== 1 || webs.length !== 1) return issues;
  const [bottom, top, web] = [boxes.get(lower[0].name), boxes.get(upper[0].name), boxes.get(webs[0].name)];
  if (!bottom || !top || !web) return issues;
  const trio = [bottom, top, web];
  for (const component of parts.filter(item => !trio.some(box => box.name === item.name))) {
    issues.push({ code: 'h_extra', components: [component.name], severity: 'warning',
      message: `“${component.name}”不是上下翼缘或腹板；请核对它是否为真实存在的加强件及其装配位置。`,
      recommendation: '如果它是边框、连接座或加强件，请保留并补充真实连接关系；如果只是模型误生成的部件，再由人工确认后删除。' });
  }
  if (trio.some(box => box.geometry.rotation.some(angle => Math.abs(angle) > 1e-6))) {
    issues.push({ code: 'h_rotation', components: trio.map(box => box.name), severity: 'warning', message: 'H 截面含旋转板件，请人工核对共同长度轴与端视截面。', recommendation: '确认三块板件的长度方向一致，再核对端视图中的翼缘宽度、腹板厚度和中心位置。' });
    return issues;
  }
  const axis = [0, 1, 2].reduce((best, i) => bottom.geometry.size[i] > bottom.geometry.size[best] ? i : best, 0);
  const other = [0, 1, 2].filter(i => i !== axis);
  const width = other.reduce((best, i) => bottom.geometry.size[i] > bottom.geometry.size[best] ? i : best);
  const height = other.find(i => i !== width)!;
  const [b, t, w] = trio.map(box => box.geometry);
  const lengthTolerance = Math.max(0.05, b.size[axis] * 0.002);
  const tolerance = Math.max(0.05, Math.min(b.size[width], b.size[height], t.size[height], w.size[width]) * 0.02);
  const add = (code: string, message: string, recommendation: string) => issues.push({ code, components: trio.map(box => box.name), severity: 'error', message, recommendation });
  if ([t, w].some(g => Math.abs(g.position[axis] - b.position[axis]) > lengthTolerance || Math.abs(g.size[axis] - b.size[axis]) > lengthTolerance))
    add('h_length', `上翼缘、下翼缘和腹板沿 ${'XYZ'[axis]} 轴须同长且两端对齐。`, '统一三块板件的长度和长度方向起点；不要通过旋转或视觉遮挡掩盖端部突出。');
  if (Math.abs(t.position[width] - b.position[width]) > tolerance || Math.abs(t.size[width] - b.size[width]) > tolerance)
    add('h_flange', '上下翼缘的宽度和宽度方向起点应一致。', '核对上下翼缘的宽度和宽度方向位置，使两块翼缘在端视图中重合对齐。');
  if (Math.abs(w.position[width] + w.size[width] / 2 - b.position[width] - b.size[width] / 2) > tolerance || w.size[width] >= b.size[width] - tolerance)
    add('h_web_center', '腹板须在翼缘宽度方向居中，且厚度小于翼缘宽度。', '在端视图中将腹板中心线对准翼缘中心线，并确认腹板厚度小于翼缘宽度。');
  if (Math.abs(w.position[height] - b.position[height] - b.size[height]) > tolerance ||
      Math.abs(t.position[height] - w.position[height] - w.size[height]) > tolerance ||
      t.position[height] <= b.position[height])
    add('h_contact', '腹板下端应接下翼缘上表面，上端应接上翼缘下表面，不应有间隙或穿插。', '调整腹板的高度位置，使其下端接触下翼缘上表面、上端接触上翼缘下表面；不要让腹板穿入翼缘。');
  return issues;
}
