import { expect, test } from '@playwright/test';
import { resolveFreeCad, runFreeCad, validateCadScript, cadDecisionErrors, isCadImageInputs, renderCadViews, partLabels } from '../server/productCad';
import { isMesh, meshDigest, renderMeshView } from '../server/meshFigure';
import { productConfig, testAssemblyMesh, testCadScript, testMesh } from './fixtures/productWorkflow';

test('CAD 脚本静态校验：只放行 FreeCAD/Part/math，拒绝文件、网络、反射与顶层调用', () => {
  expect(validateCadScript(testCadScript)).toEqual([]);
  expect(validateCadScript('')).toHaveLength(1);
  expect(validateCadScript('import Part\n')).toEqual(expect.arrayContaining([expect.stringContaining('build_model')]));
  for (const bad of ['import os\n', 'from subprocess import run\n', 'import FreeCADGui\n', 'x = open("a")\n', 'y = getattr(Part, "makeBox")\n', 'z = __import__("os")\n', 'from FreeCAD import *\n', 'print(1)\n', 'build_model()\n', 'import socket as s\n', 'doc = FreeCAD.newDocument()\n']) {
    const errors = validateCadScript(`import Part\ndef build_model():\n    return Part.makeBox(1, 1, 1)\n${bad}`);
    expect(errors, bad).not.toEqual([]);
  }
  expect(validateCadScript(`import Part\ndef build_model():\n    return Part.makeBox(1, 1, 1)\n# import os in a comment is fine\n`)).toEqual([]);
  expect(cadDecisionErrors({ summary: 'ok', assumptions: [], script: testCadScript })).toEqual([]);
  expect(cadDecisionErrors({ summary: 'ok', assumptions: [], script: testCadScript, keyStructure: { point: [0, 0], radius: 1 } })).toEqual([expect.stringContaining('keyStructure')]);
  expect(cadDecisionErrors({ summary: '', assumptions: 'x', script: 1 }).length).toBeGreaterThanOrEqual(3);
});
test('视觉输入只接受已登记视角的 PNG/JPEG/WebP data URL，并限制大小', () => {
  const png = `data:image/png;base64,${Buffer.alloc(100).toString('base64')}`;
  expect(isCadImageInputs([{ templateId: 'color-hero', dataUrl: png }])).toBe(true);
  expect(isCadImageInputs([{ templateId: 'color-hero', dataUrl: png }, { templateId: 'color-hero', dataUrl: png }])).toBe(false);
  expect(isCadImageInputs([{ templateId: 'color-preview', dataUrl: png }])).toBe(false);
  expect(isCadImageInputs([{ templateId: 'color-hero', dataUrl: 'https://evil.example/a.png' }])).toBe(false);
  expect(isCadImageInputs([{ templateId: 'color-hero', dataUrl: `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024 * 4 / 3)}` }])).toBe(false);
  expect(isCadImageInputs([])).toBe(false);
});
test('网格投影：隐藏线消除后每个视角只剩可见轮廓，输出可嵌入的 SVG', () => {
  expect(isMesh(testMesh)).toBe(true);
  expect(isMesh({ vertices: [[0, 0, 0]], triangles: [[0, 0, 0]] })).toBe(false);
  expect(meshDigest(testMesh)).toMatch(/^[a-f0-9]{64}$/);
  const front = renderMeshView(testMesh, { direction: [0, -1, 0], up: [0, 0, 1] });
  expect(front.width).toBe(1400); expect(front.height).toBe(1000);
  expect(front.svg.startsWith('<svg')).toBe(true); expect(front.svg.trimEnd().endsWith('</svg>')).toBe(true);
  // 正投影的长方体前视图只有 4 条可见边；对角线与背面边不出现。
  expect(front.visibleSegments).toBe(4);
  const iso = renderMeshView(testMesh, { direction: [1, 0.75, 0.55] });
  expect(iso.visibleSegments).toBe(9);
  expect(() => renderMeshView(testMesh, { direction: [0, 0, 0] })).toThrow();
  expect(() => renderMeshView({ vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], triangles: [[0, 1, 2]] }, { direction: [0, -1, 0] })).toThrow('没有可投影');
  const views = renderCadViews(testMesh, '测试');
  expect(views.map(view => view.view)).toEqual(['iso', 'front', 'top', 'right']);
  expect(views.every(view => /^[a-f0-9]{64}$/.test(view.digest) && !view.svg.includes('<script'))).toBe(true);
  // 按部件标号：引出线落在该部件可见区域的中心；被遮住的部件在该视角不标；标号文字做了 XML 转义。
  const isoLabels = renderMeshView(testAssemblyMesh, { direction: [1, 0.75, 0.55], partLabels: true, keyCircle: { point: [60, 30, 45], radius: 24 } });
  expect(isoLabels.labelledParts).toEqual(['1', '2']); expect(isoLabels.labelCount).toBe(3); expect(isoLabels.svg).toContain('>1<'); expect(isoLabels.svg).toContain('>2<'); expect(isoLabels.svg).toContain('<circle'); expect(isoLabels.svg).toContain('>A<');
  const bottom = renderMeshView(testAssemblyMesh, { direction: [0, 0, -1], up: [0, 1, 0], partLabels: true });
  expect(bottom.labelledParts).toEqual(['1']);
  expect(renderMeshView(testMesh, { direction: [1, 0.75, 0.55], labels: [{ text: '<b>', point: [60, 30, 30] }] }).svg).toContain('&lt;b&gt;');
  expect(() => partLabels(testAssemblyMesh, [{ number: '1', name: '底座' }, { number: '2', name: '夹持座' }, { number: '3', name: '螺栓' }])).toThrow();
  expect(partLabels(testAssemblyMesh, [{ number: '1', name: '底座' }, { number: '2', name: '夹持座' }]).map(label => label.point)).toEqual([[60, 30, 15], [60, 30, 45]]);
  const annotated = renderCadViews(testAssemblyMesh, '测试', { point: [60, 30, 45], radius: 24 });
  expect(annotated.filter(view => view.svg.includes('<circle')).map(view => view.view)).toEqual(['iso']);
  expect(annotated.every(view => view.svg.includes('>1<') && view.svg.includes('>2<'))).toBe(true);
});
test('FreeCAD 命令行：脚本在隔离目录执行，失败和超时不产出附图', async () => {
  const command = await resolveFreeCad(productConfig);
  test.skip(!command, '本机未安装 FreeCAD，跳过真实建模测试。');
  const run = await runFreeCad(testCadScript, command!, { timeoutMs: 120000 });
  expect(run.mesh.vertices.length).toBeGreaterThanOrEqual(16); expect(run.bbox).toEqual([0, 0, 0, 120, 60, 64]);
  expect([...new Set(run.mesh.parts)].sort()).toEqual(['1', '2', '3']);
  expect(renderCadViews(run.mesh, '测试')).toHaveLength(4);
  await expect(runFreeCad('import Part\ndef build_model():\n    return Part.makeBox(0, 0, 0)\n', command!, { timeoutMs: 120000 })).rejects.toMatchObject({ code: 'CAD_SCRIPT_FAILED' });
  await expect(runFreeCad('import Part\ndef build_model():\n    import os\n    return Part.makeBox(1, 1, 1)\n', command!, { timeoutMs: 120000 })).rejects.toMatchObject({ code: 'CAD_SCRIPT_REJECTED' });
  await expect(runFreeCad('import Part\ndef build_model():\n    while True:\n        pass\n', command!, { timeoutMs: 8000 })).rejects.toMatchObject({ code: 'CAD_TIMEOUT' });
});
