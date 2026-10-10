export type PatentShape =
  | 'box'
  | 'cylinder'
  | 'tube'
  | 'spur_gear'
  | 'ring_gear'
  | 'cone'
  | 'sphere'
  | 'ellipsoid'
  | 'prism'
  | 'torus'
  | 'spring'
  | 'threaded_cylinder';

export const geometryShapeLabels: Record<PatentShape, string> = {
  box: '长方体',
  cylinder: '圆柱体',
  tube: '圆管',
  spur_gear: '外齿直齿轮',
  ring_gear: '内齿圈',
  cone: '圆锥体',
  sphere: '球体',
  ellipsoid: '椭球体',
  prism: '棱柱',
  torus: '环面',
  spring: '螺旋弹簧',
  threaded_cylinder: '螺纹圆柱',
};

export const geometryShapeHelp: Record<PatentShape, string> = {
  box: '尺寸为长,宽,高；位置为旋转前左下后角。',
  cylinder: '尺寸为半径,长度,0；位置为底面圆心。',
  tube: '尺寸为外半径,长度,内半径；位置为底面圆心。',
  spur_gear: '尺寸为模数,齿数,齿宽；位置为底面中心。',
  ring_gear: '尺寸为模数,齿数,齿宽；位置为底面中心。',
  cone: '尺寸为底面半径,长度,顶面半径；位置为底面中心。',
  sphere: '尺寸为半径；位置为球心。',
  ellipsoid: '尺寸为X半径,Y半径,Z半径；位置为中心。',
  prism: '尺寸为外接圆半径,侧面数,长度；位置为底面中心。',
  torus: '尺寸为主半径,管半径,0；位置为中心。',
  spring: '尺寸为线圈半径,轴向长度,线径；位置为底面中心。',
  threaded_cylinder: '尺寸为半径,长度,螺距；位置为底面中心。',
};

export const geometryShapeAliases: Record<string, PatentShape> = {
  长方体: 'box',
  方体: 'box',
  圆柱体: 'cylinder',
  圆柱: 'cylinder',
  圆管: 'tube',
  外齿直齿轮: 'spur_gear',
  外齿轮: 'spur_gear',
  内齿圈: 'ring_gear',
  齿圈: 'ring_gear',
  圆锥体: 'cone',
  圆锥: 'cone',
  球体: 'sphere',
  球: 'sphere',
  椭球体: 'ellipsoid',
  椭球: 'ellipsoid',
  棱柱: 'prism',
  多棱柱: 'prism',
  环面: 'torus',
  圆环: 'torus',
  螺旋弹簧: 'spring',
  弹簧: 'spring',
  螺纹圆柱: 'threaded_cylinder',
  螺纹杆: 'threaded_cylinder',
  螺纹轴: 'threaded_cylinder',
};

export const geometryShapeCodes = Object.keys(geometryShapeLabels) as PatentShape[];

/** Shared contract for AI prompts, text parsing, validation and Word export. */
export const geometryProtocolPrompt = `支持的参数化几何只有以下类型：${geometryShapeCodes.map(shape => `${shape}（${geometryShapeLabels[shape]}，${geometryShapeHelp[shape]}）`).join('；')}。所有部件的 geometry 必须使用上述 shape、三项 size、三项 position 和三项 rotation；球体的 size 为[半径,0,0]。这些是可编辑的黑白参数化线稿示意尺寸，不是实测尺寸；附图应以外部可见轮廓和清晰装配关系为主，不应把产品表达成透明线框或堆叠的内部零件。自由曲面、叶片复杂曲面、任意非参数轮廓仍不能由本协议表达，必须返回 unsupported，不得用其他形状伪装。`;

const finiteTuple = (value: unknown, count: number, predicate: (item: number) => boolean): value is number[] =>
  Array.isArray(value) && value.length === count && value.every(item => typeof item === 'number' && Number.isFinite(item) && predicate(item));

export function isPatentShape(value: unknown): value is PatentShape {
  return typeof value === 'string' && Object.hasOwn(geometryShapeLabels, value);
}

export function isGeometrySize(shape: PatentShape, size: unknown): size is [number, number, number] {
  if (!finiteTuple(size, 3, item => item >= 0 && item <= 10000)) return false;
  const [a, b, c] = size;
  if (shape === 'box' || shape === 'ellipsoid') return a >= 0.1 && b >= 0.1 && c >= 0.1;
  if (shape === 'cylinder') return a >= 0.1 && b >= 0.1 && c === 0;
  if (shape === 'tube') return a >= 0.1 && b >= 0.1 && c >= 0.1 && c < a;
  if (shape === 'spur_gear' || shape === 'ring_gear') return a >= 0.1 && Number.isInteger(b) && b >= 8 && b <= 120 && c >= 0.1 && a * (b + (shape === 'ring_gear' ? 8 : 2)) / 2 <= 10000;
  if (shape === 'cone') return a >= 0.1 && b >= 0.1 && c >= 0 && a * 2 <= 10000 && c * 2 <= 10000;
  if (shape === 'sphere') return a >= 0.1 && b === 0 && c === 0;
  if (shape === 'prism') return a >= 0.1 && Number.isInteger(b) && b >= 3 && b <= 32 && c >= 0.1;
  if (shape === 'torus') return a >= 0.1 && b >= 0.1 && b < a && c === 0;
  if (shape === 'spring') return a >= 0.1 && b >= 0.1 && c >= 0.1 && c < a;
  return a >= 0.1 && b >= 0.1 && c >= 0.1 && c <= b;
}

export function isGeometrySpec(value: unknown): value is { shape: PatentShape; position: [number, number, number]; size: [number, number, number]; rotation: [number, number, number]; surfaceGrid?: [number, number] } {
  if (!value || typeof value !== 'object') return false;
  const geometry = value as { shape?: unknown; position?: unknown; size?: unknown; rotation?: unknown; surfaceGrid?: unknown };
  return isPatentShape(geometry.shape) && finiteTuple(geometry.position, 3, item => Math.abs(item) <= 10000) &&
    finiteTuple(geometry.rotation, 3, item => Math.abs(item) <= 360) && isGeometrySize(geometry.shape, geometry.size) &&
    (geometry.surfaceGrid === undefined || geometry.shape === 'box' && finiteTuple(geometry.surfaceGrid, 2, item => Number.isInteger(item) && item >= 1 && item <= 20));
}

export function geometryDimensions(shape: PatentShape, size: readonly number[]) {
  if (shape === 'cylinder') return size.slice(0, 2);
  if (shape === 'sphere') return size.slice(0, 1);
  return [...size];
}
