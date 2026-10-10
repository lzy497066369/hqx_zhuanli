import { expect, test } from '@playwright/test';
import { CAMERAS, createFigure, figureLabels, projectPoint } from '../src/features/utility/drawingModel';
import { buildContentAssembly, CONTENT_MODEL_REVISION, isContentDesign, isDrawingCurrent, parseGeometry } from '../src/features/utility/contentDrawing';
import { isPatentGeometry, structureToGeometryText } from '../src/features/utility/patentStructure';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { sampleDraft } from './fixtures/structureFlow';
import { defaultUtilityDrawing, defaultUtilityParts, initialProjects, isUtilityDrawing, makeUtilityMaterials } from '../src/data';
import { bracketTitle, drawingFixture, jointTitle, jointGeometry, jointStructure } from './fixtures/drawing';

test('内容建模：不同产品内容得到不同部件数、轮廓与空心管结构，无固定案例兜底', () => {
  const bracket = buildContentAssembly(drawingFixture().design!);
  const joint = buildContentAssembly(drawingFixture(jointTitle, jointGeometry, jointStructure).design!);
  expect(bracket.parts).toHaveLength(4);
  expect(joint.parts).toHaveLength(2);
  expect(joint.parts[0].edges).toHaveLength(136);
  expect(bracket.parts).not.toEqual(joint.parts);
  expect(parseGeometry('食品设备由料斗及输送机组成').errors.length).toBeGreaterThan(0);
  expect(parseGeometry('').components).toEqual([]);
});

test('板面网格仅在确认的几何参数中出现，并保留在整体图可见线条', () => {
  const component = { id: 1, componentId: 'C01', name: '光伏板体', shape: 'box' as const, position: [0, 0, 0] as [number, number, number], size: [120, 80, 4] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
  const design = { revision: 'utility-content-model-v1' as const, title: '一种光伏板', source: 'test', generatedAt: '', components: [component], detailPartId: 1 };
  const plain = buildContentAssembly(design);
  const gridded = buildContentAssembly({ ...design, components: [{ ...component, surfaceGrid: [6, 4] as [number, number] }] });
  expect(plain.parts[0].edges).toHaveLength(12);
  expect(gridded.parts[0].edges).toHaveLength(20);
  expect(createFigure(gridded, 'overall').parts[0].edges.length).toBeGreaterThan(createFigure(plain, 'overall').parts[0].edges.length);
  expect(isPatentGeometry({ ...component, shape: 'cylinder', size: [1, 1, 0], surfaceGrid: [6, 4] })).toBe(false);
});

test('外观特征会保留到绘图部件，并可为已描述的光伏板网格补足可见线条', () => {
  const design = {
    revision: CONTENT_MODEL_REVISION,
    title: '一种光伏板',
    source: 'preview',
    generatedAt: '',
    components: [{ id: 1, componentId: 'C01', referenceNo: '201', name: '光伏板体', visualFeature: '长方形薄板，表面有深色电池片网格', shape: 'box' as const, position: [0, 0, 0] as [number, number, number], size: [120, 80, 4] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] }],
    detailPartId: 1,
  };
  const assembly = buildContentAssembly(design);
  expect(assembly.parts[0].visualFeature).toContain('电池片网格');
  expect(assembly.parts[0].edges.length).toBeGreaterThan(12);
});

test('母模型：整体、侧面与局部共用用户输入部件，消隐分段仍来自原始边', () => {
  const model = buildContentAssembly(drawingFixture().design!);
  const snapshot = JSON.stringify(model);
  const pointOnSegment = (point: readonly [number, number], segment: readonly [[number, number], [number, number]]) => {
    const [a, b] = segment;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-12) return Math.hypot(point[0] - a[0], point[1] - a[1]) < 1e-6;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t)) < 1e-6;
  };
  for (const figure of ['overall', 'side', 'detail'] as const) {
    const view = createFigure(model, figure);
    view.parts.forEach((part, i) => {
      expect(part.source).toBe(model.parts[i]);
      const originalEdges = model.parts[i].edges.map(edge => edge.map(point => projectPoint(point, CAMERAS[figure])) as unknown as readonly [[number, number], [number, number]]);
      part.edges.forEach(edge => edge.forEach(point => {
        expect(originalEdges.some(original => pointOnSegment(point, original))).toBe(true);
        expect(point.every(Number.isFinite)).toBe(true);
      }));
    });
  }
  expect(JSON.stringify(model)).toBe(snapshot);
  expect(projectPoint([99, 23, 45], CAMERAS.side)).toEqual([23, -45]);
  expect(projectPoint([-88, 23, 45], CAMERAS.side)).toEqual([23, -45]);
});

test('局部图：A区来自所选部件，裁切放大不移动或重组任何部件', () => {
  const model = buildContentAssembly(drawingFixture().design!);
  const overall = createFigure(model, 'overall'), detail = createFigure(model, 'detail');
  expect(detail.parts).toEqual(overall.parts);
  expect(detail.sourceBounds).toEqual(overall.detailBounds);
  expect(detail.scale).toBeGreaterThan(overall.scale);
  const zoom = detail.scale / overall.scale;
  for (const part of detail.parts) for (const [a, b] of part.edges) {
    const [oa, ob] = [overall.toSheet(a), overall.toSheet(b)];
    const [da, db] = [detail.toSheet(a), detail.toSheet(b)];
    expect(db[0] - da[0]).toBeCloseTo((ob[0] - oa[0]) * zoom);
    expect(db[1] - da[1]).toBeCloseTo((ob[1] - oa[1]) * zoom);
  }
  for (const label of figureLabels(detail)) {
    const part = detail.parts.find(p => p.source.id === label.id)!;
    const attached = part.edges.some(([start, end]) => {
      const a = detail.toSheet(start), b = detail.toSheet(end);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((label.anchor[0] - a[0]) * dx + (label.anchor[1] - a[1]) * dy) / lengthSquared)) : 0;
      const nearest = [a[0] + dx * t, a[1] + dy * t];
      return Math.hypot(label.anchor[0] - nearest[0], label.anchor[1] - nearest[1]) < 1e-6;
    });
    expect(attached, `引线端点未落在 ${label.componentId || label.id} 的投影线段上`).toBe(true);
    expect(label.anchor).not.toEqual(detail.toSheet(part.anchor));
  }
});

test('附图标注：空心件和重合部件的引线端点仍分别绑定到自身轮廓', () => {
  const model = buildContentAssembly(drawingFixture(jointTitle, jointGeometry, jointStructure).design!);
  const view = createFigure(model, 'overall');
  const labels = figureLabels(view);
  expect(labels).toHaveLength(2);
  expect(labels[0].anchor).not.toEqual(labels[1].anchor);
  labels.forEach(label => {
    const part = view.parts.find(item => item.source.id === label.id)!;
    const nearestDistance = Math.min(...part.edges.map(([start, end]) => {
      const a = view.toSheet(start), b = view.toSheet(end);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((label.anchor[0] - a[0]) * dx + (label.anchor[1] - a[1]) * dy) / lengthSquared)) : 0;
      return Math.hypot(label.anchor[0] - (a[0] + dx * t), label.anchor[1] - (a[1] + dy * t));
    }));
    expect(nearestDistance).toBeLessThan(1e-6);
  });
});

test('附图标注：引线到达所属轮廓前不穿过其他部件轮廓', () => {
  const model = buildContentAssembly(drawingFixture().design!);
  for (const figure of ['overall', 'side', 'detail'] as const) {
    const view = createFigure(model, figure);
    const labels = figureLabels(view);
    for (const label of labels) {
      const line = [label.leaderStart, label.anchor] as const;
      const cross = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) =>
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const properCross = (first: readonly [[number, number], [number, number]], second: readonly [[number, number], [number, number]]) =>
        cross(first[0], first[1], second[0]) * cross(first[0], first[1], second[1]) < -1e-6 &&
        cross(second[0], second[1], first[0]) * cross(second[0], second[1], first[1]) < -1e-6;
      const otherEdges = view.parts.filter(item => item.source.id !== label.id).flatMap(item => item.edges.map(edge => edge.map(view.toSheet) as unknown as readonly [[number, number], [number, number]]));
      expect(otherEdges.some(edge => properCross(line, edge)), `${figure} ${label.componentId} crosses another part`).toBe(false);
    }
  }
});

test('内容联动：尺寸、位置、形状和旋转都实际改变几何，纯改名不改变结构', () => {
  const design = drawingFixture().design!;
  const original = buildContentAssembly(design);
  const moved = structuredClone(design);
  moved.components[1].position[2] += 12;
  const changed = buildContentAssembly(moved);
  original.parts[1].edges.forEach((edge, i) => edge.forEach((point, j) => {
    expect(changed.parts[1].edges[i][j]).toEqual([point[0], point[1], point[2] + 12]);
  }));
  expect(changed.parts[0]).toEqual(original.parts[0]);
  moved.components[0].size[0] = 200;
  expect(buildContentAssembly(moved).parts[0]).not.toEqual(original.parts[0]);
  const rotated = structuredClone(design);
  rotated.components[0].rotation[2] = 90;
  const point = buildContentAssembly(rotated).parts[0].edges[0][1];
  expect(point[0]).toBeCloseTo(0);
  expect(point[1]).toBeCloseTo(160);
  const renamed = structuredClone(design);
  renamed.components[0].name = '支撑底座';
  expect(buildContentAssembly(renamed).parts).toEqual(original.parts);
});

test('解析：拒绝非法、遗漏与复杂形状，不静默丢掉用户内容', () => {
  for (const input of [
    '箱 | 长方体 | 0,0,0 | -1,2,3', '箱 | 长方体 | 0,,0 | 1,2,3',
    '箱 | 长方体 | 0,0,Infinity | 1,2,3', '箱 | 长方体 | 0,0,0 | 1,2,3 | 0,0,361',
    '管 | 圆管 | 0,0,0 | 10,20,10', '管 | 圆管 | 0,0,0 | 10,20,0',
    '太阳轮 | 外齿直齿轮 | 0,0,0 | 2,7,10', '太阳轮 | 外齿直齿轮 | 0,0,0 | 2,20.5,10',
    '太阳轮 | 外齿直齿轮 | 0,0,0 | 2,121,10',
    '内齿圈 | 内齿圈 | 0,0,0 | 2,20.5,10',
    '壳 | 自由曲面 | 0,0,0 | 1,2,3', '箱 | 长方体 | 0,0,0 | 1,2,3\n另附自动猜测连接',
    '箱 | 长方体 | 0,0,0 | 1,2,3\n箱 | 长方体 | 2,0,0 | 1,2,3',
    Array.from({ length: 31 }, (_, i) => `${i}号 | 圆柱 | 0,0,0 | 1,2`).join('\n'),
  ]) {
    expect(parseGeometry(input).errors.length, input).toBeGreaterThan(0);
    expect(parseGeometry(input).components, input).toEqual([]);
  }
  expect(parseGeometry('支柱｜圆柱｜0，0，0｜8，100｜90，0，0').components).toHaveLength(1);
});

test('统一几何协议：所有参数化形状都能解析、校验、渲染并往返文本', () => {
  const text = [
    '长方体件 | 长方体 | 0,0,0 | 20,10,5',
    '圆柱件 | 圆柱体 | 30,0,0 | 4,20',
    '圆管件 | 圆管 | 60,0,0 | 8,20,3',
    '外齿件 | 外齿直齿轮 | 90,0,0 | 2,20,10',
    '内齿件 | 内齿圈 | 120,0,0 | 2,60,10',
    '圆锥件 | 圆锥体 | 150,0,0 | 8,20,2',
    '球体件 | 球体 | 180,0,0 | 6',
    '椭球件 | 椭球体 | 210,0,0 | 8,6,4',
    '棱柱件 | 棱柱 | 240,0,0 | 10,6,20',
    '环面件 | 环面 | 270,0,0 | 15,4,0',
    '弹簧件 | 螺旋弹簧 | 300,0,0 | 12,60,2',
    '螺纹件 | 螺纹圆柱 | 330,0,0 | 8,60,3',
  ].join('\n');
  const parsed = parseGeometry(text);
  expect(parsed.errors).toEqual([]);
  expect(parsed.components).toHaveLength(12);
  parsed.components.forEach(component => expect(isPatentGeometry({ ...component, id: undefined, name: undefined })).toBe(true));
  const design = { ...drawingFixture().design!, components: parsed.components, detailPartId: 1 };
  const assembly = buildContentAssembly(design);
  expect(assembly.parts).toHaveLength(12);
  expect(assembly.parts.every(part => part.edges.length > 0 && part.edges.every(edge => edge.every(point => point.every(Number.isFinite))))).toBe(true);
  const roundTrip = parseGeometry(structureToGeometryText({
    version: 1,
    modelVersion: 'model-test',
    productTitle: '一种参数化几何测试结构',
    technicalField: '机械结构',
    baseStructure: '参数化部件组成结构。',
    components: parsed.components.map((component, index) => ({ id: `C${String(index + 1).padStart(2, '0')}`, name: component.name, kind: index === 0 ? 'innovation' as const : 'base' as const, purpose: '测试', position: '示意位置', whyNeeded: '测试', geometry: { shape: component.shape, position: component.position, size: component.size, rotation: component.rotation } })),
    connections: parsed.components.slice(1).map((component, index) => ({ id: `R${String(index + 1).padStart(2, '0')}`, from: 'C01', to: `C${String(index + 2).padStart(2, '0')}`, relation: 'connected_to' as const, description: '测试连接' })),
    motions: [], functions: ['测试'], innovationPoints: ['测试'], problemSolved: '测试', workingPrinciple: '测试',
    figureSpecs: [
      { id: 'F01', title: '整体', kind: 'overall' as const, componentIds: parsed.components.map((_, index) => `C${String(index + 1).padStart(2, '0')}`), connectionIds: parsed.components.slice(1).map((_, index) => `R${String(index + 1).padStart(2, '0')}`) },
      { id: 'F02', title: '侧面', kind: 'side' as const, componentIds: parsed.components.map((_, index) => `C${String(index + 1).padStart(2, '0')}`), connectionIds: parsed.components.slice(1).map((_, index) => `R${String(index + 1).padStart(2, '0')}`) },
      { id: 'F03', title: '局部', kind: 'detail' as const, componentIds: ['C01'], connectionIds: [] },
    ],
  }));
  expect(roundTrip.errors).toEqual([]);
  expect(roundTrip.components.map(component => component.shape)).toEqual(parsed.components.map(component => component.shape));
  expect(roundTrip.components.map(component => component.size)).toEqual(parsed.components.map(component => component.size));
});

test('外齿直齿轮按齿数产生可见齿顶与齿根，编译模型可往返绘图文本', () => {
  const draft = sampleDraft('行星搅拌机构', '太阳轮');
  draft.components[2].geometry = { shape: 'spur_gear', position: [35, 40, 12], size: [2, 20, 10], rotation: [0, 0, 0] };
  draft.components[0].geometry = { shape: 'tube', position: [0, 0, 0], size: [60, 40, 55], rotation: [0, 0, 0] };
  const compiled = compileStructureDraft(draft);
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
  if (!compiled.success) return;
  const parsed = parseGeometry(structureToGeometryText(compiled.model));
  expect(parsed.errors).toEqual([]);
  expect(parsed.components.map(item => item.shape)).toEqual(['tube', 'box', 'spur_gear']);
  expect(parsed.components.map(item => item.size)).toEqual(draft.components.map(item => item.geometry!.size));
  const design = drawingFixture().design!;
  const assembly = buildContentAssembly({ ...design, components: parsed.components, detailPartId: 3 });
  const gear = assembly.parts[2];
  expect(gear.edges.length).toBeGreaterThan(100);
  const radii = gear.edges.flat().map(([x, y]) => Math.hypot(x - 35, y - 40));
  expect(Math.min(...radii)).toBeCloseTo(17.5);
  expect(Math.max(...radii)).toBeCloseTo(22);
  expect(isPatentGeometry({ ...draft.components[2].geometry, size: [2, 20.5, 10] })).toBe(false);
  const ringText = '固定内齿圈 | 内齿圈 | 0,0,12 | 2,60,10';
  const ring = parseGeometry(ringText);
  expect(ring.errors).toEqual([]);
  const ringEdges = buildContentAssembly({ ...design, components: ring.components, detailPartId: 1 }).parts[0].edges;
  const ringRadii = ringEdges.flat().map(([x, y]) => Math.hypot(x, y));
  expect(Math.min(...ringRadii)).toBeCloseTo(58);
  expect(Math.max(...ringRadii)).toBeCloseTo(68);
  expect(isPatentGeometry({ shape: 'ring_gear', position: [0, 0, 0], size: [2, 60, 10], rotation: [0, 0, 0] })).toBe(true);
});

test('数据校验与旧版迁移：旧模板不再自动生成，新图绑定专利名称和完整内容', () => {
  const project = { ...initialProjects.find(p => p.category === 'utility')!, name: bracketTitle };
  const blank = defaultUtilityDrawing(project);
  expect(blank.parts).toEqual([]);
  expect(blank.design).toBeUndefined();
  expect(isUtilityDrawing(blank)).toBe(true);
  expect(() => makeUtilityMaterials(project, blank)).toThrow(/Patent Structure Model/);
  const legacy = { ...blank, parts: defaultUtilityParts, model: { mastHeight: 240, carriageHeight: 135 }, workingPrinciple: '旧版用户填写内容' };
  expect(isUtilityDrawing(legacy)).toBe(true);
  expect(() => makeUtilityMaterials(project, legacy)).toThrow(/Patent Structure Model/);
  const drawing = drawingFixture();
  expect(isUtilityDrawing(drawing)).toBe(true);
  expect(isDrawingCurrent(project.name, drawing)).toBe(true);
  expect(isDrawingCurrent('另一个名称', drawing)).toBe(false);
  for (const key of ['structure', 'workingPrinciple', 'technicalField', 'geometryText'] as const) {
    expect(isDrawingCurrent(project.name, { ...drawing, [key]: '修改内容' })).toBe(false);
  }
  for (const invalid of [null, {}, { ...drawing.design, components: [null] }, { ...drawing.design, detailPartId: 999 }]) expect(isContentDesign(invalid)).toBe(false);
  expect(isUtilityDrawing({ ...drawing, parts: [null] })).toBe(false);
  expect(() => makeUtilityMaterials(project, drawing)).toThrow(/Patent Structure Model/);
  expect(() => makeUtilityMaterials(project, { ...drawing, structure: '已改变' })).toThrow(/Patent Structure Model/);
});
