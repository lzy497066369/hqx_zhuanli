import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Project } from '../../src/data';
import type { AiConfig } from '../../server/aiSupport';
import { signProductArtifact } from '../../server/productProof';
import { LOGIC_DIMENSIONS, PREVIEW_VIEWS, createProductWorkflow, renderProductDescription } from '../../src/features/product/productWorkflow';
import type { LogicResult, ProductBrief, ProductCad, ProductDesign, ProductImage, ProductMaterials, ProductPreview, ProductReview, ProductWorkflow } from '../../src/features/product/productWorkflow';
import { buildPatentFigurePrompt, buildPreviewPrompt } from '../../src/features/product/productPrompts';
import { meshDigest } from '../../server/meshFigure';
import type { Mesh } from '../../server/meshFigure';
import { renderCadViews } from '../../server/productCad';

export const productConfig: AiConfig = { baseUrl: 'https://text.example/v1', apiKey: 'text-test-secret', model: 'text-test-model',
  image: { baseUrl: 'https://image.example/v1', apiKey: 'image-test-secret', model: 'image-test-model' } };
export const productTitle = '一种带滑槽锁紧结构的光伏组件安装支架';
const when = '2026-10-09T08:00:00.000Z';
export const productProject: Project = { id: 'product-flow-test', name: productTitle, category: 'utility', owner: '示例设备有限公司', description: '', status: 'draft', updatedAt: when,
  naming: { version: 1, profile: { company: '示例设备有限公司', business: '光伏组件安装支架', product: '光伏组件安装支架', features: '轨道底座、滑动夹持座、锁紧螺栓', improvementType: 'structure', excludedTerms: '' },
    selectedName: productTitle, candidates: [{ name: productTitle, product: '光伏组件安装支架', feature: '轨道底座、滑动夹持座、锁紧螺栓', basis: '用户已选特征', inferred: false }], confirmed: true } };
export const productSelection = createProductWorkflow(productProject).selection;
export function logicalResult(conflicts = false): LogicResult {
  return { verdict: conflicts ? 'conflicts' : 'feasible', summary: conflicts ? '固定连接与连续滑动在同一工况下冲突。' : '各部件在调节与锁紧状态下能够保持逻辑一致。',
    checks: Object.keys(LOGIC_DIMENSIONS).map(dimension => ({ dimension: dimension as keyof typeof LOGIC_DIMENSIONS, status: conflicts && dimension === 'motion' ? 'conflict' : 'pass', explanation: dimension === 'motion' ? '解锁时调节，锁紧后固定。' : '根据当前资料未发现矛盾，仍需工程核实。' })),
    assumptions: ['连接尺寸与承载能力需工程核实。'], conflicts: conflicts ? [{ id: 'conflict-1', title: '夹持座不能既焊死又滑动', reason: '用户选择了焊接固定及同一部件自由滑动，需要取舍。', affectedChoiceIds: ['feature-1', 'feature-2'], options: [
      { id: 'keep-fixed', label: '保留固定式结构，去掉滑动要求', explanation: '将产品定义为固定式支架。', removeIds: ['feature-2'], replacements: [], proposedName: '一种带固定连接结构的光伏组件安装支架' },
      { id: 'keep-slide', label: '保留滑动调节，改成可解锁连接', explanation: '以滑槽导向和锁紧螺栓代替永久焊接。', removeIds: [], replacements: [{ id: 'feature-1', text: '轨道设滑槽，夹持座通过可解锁螺栓连接，解锁时滑动。' }] },
    ] }] : [] };
}
export function makeReview(selection = productSelection, conflicts = false, id = 'review-1'): ProductReview {
  return signProductArtifact('review', { ...logicalResult(conflicts), id, selection, createdAt: when }, productConfig);
}
export function makeDesign(selection = productSelection): ProductDesign {
  return { title: selection.proposedName, technicalField: '光伏设备安装支承技术领域。', useCase: '用于安装面上的光伏组件定位与夹持。',
    overview: '本产品包括轨道底座、夹持座和锁紧螺栓。轨道底座固定于安装面，夹持座沿滑槽调整位置，并在目标位置通过锁紧螺栓固定。调节和锁紧分属不同工作状态，不要求同一部件同时固定和自由运动。',
    appearance: `横向长条底座，灰白主体、蓝色夹持座。前视图显示支承高度，俯视图显示平行滑槽，右视图显示夹持截面。${selection.visualPreferences}`,
    components: [
      { number: '1', name: '轨道底座', structure: '长条形底座，顶面有直线滑槽。', connection: '通过螺栓固定在安装面。', purpose: '支承与导向。' },
      { number: '2', name: '夹持座', structure: '布置在轨道上，具有平面支承台和夹持面。', connection: '通过滑槽与底座配合，解锁后可滑动。', purpose: '调节和定位组件。' },
      { number: '3', name: '锁紧螺栓', structure: '穿过夹持座，与滑槽内螺纹件连接。', connection: '旋紧后锁定夹持座。', purpose: '锁定调节位置。' },
    ], workingPrinciple: '先解锁螺栓，滑动夹持座确定位置，再旋紧螺栓固定组件。', innovation: '滑槽导向与可解锁紧固连接相配合。',
    assumptions: ['尺寸、公差和承载需工程核实。'], choiceCoverage: selection.choices.map(choice => ({ choiceId: choice.id, description: `落实要求：${choice.text}` })) };
}
export function makeBrief(review = makeReview(), id = 'brief-1'): ProductBrief {
  const design = makeDesign(review.selection);
  return signProductArtifact('brief', { id, reviewId: review.id, selection: review.selection, design, description: renderProductDescription(design), createdAt: when }, productConfig);
}
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(kind: string, value: Buffer) { const data = Buffer.concat([Buffer.from(kind), value]); const length = Buffer.alloc(4); length.writeUInt32BE(value.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data)); return Buffer.concat([length, data, crc]); }
export function testProductPng(): Buffer {
  const width = 360, height = 220;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) { rows[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) {
    const border = ((y >= 40 && y <= 100) && [40, 120, 155, 235, 270, 330].some(edge => Math.abs(edge - x) < 2)) || ([40, 100].some(edge => Math.abs(edge - y) < 2) && ((x >= 40 && x <= 120) || (x >= 155 && x <= 235) || (x >= 270 && x <= 330)));
    const i = y * (width * 3 + 1) + 1 + x * 3;
    if (border) { rows[i] = 30; rows[i + 1] = 90; rows[i + 2] = 160; }
  } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export const imageBytes = testProductPng();
export function makeImage(brief = makeBrief(), kind: 'preview' | 'patent' = 'preview', id = `image-${brief.id}-${kind}`, templateId = kind === 'preview' ? 'color-hero' : 'patent-structure'): ProductImage {
  const reference = signProductArtifact('image', { id, briefId: brief.id, kind, templateId, mimeType: 'image/png' as const,
    digest: createHash('sha256').update(imageBytes).digest('hex'), createdAt: when }, productConfig);
  return { ...reference, dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`, model: productConfig.image!.model,
    prompt: kind === 'preview' ? buildPreviewPrompt(brief, templateId) : buildPatentFigurePrompt(brief, templateId) };
}
/** 四张彩色预览及其签名集合，与服务端 preview 路由返回的结构一致。 */
export function makePreview(brief = makeBrief(), id = `preview-${brief.id}`): ProductPreview {
  const images = PREVIEW_VIEWS.map(view => makeImage(brief, 'preview', `image-${brief.id}-${view.id}`, view.templateId));
  const digest = createHash('sha256').update(images.map(image => `${image.templateId}:${image.digest}`).join('\n')).digest('hex');
  return { ...signProductArtifact('preview', { id, briefId: brief.id, viewIds: PREVIEW_VIEWS.map(view => view.id), digest, createdAt: when }, productConfig), images };
}
/** 固定长方体网格：不依赖 FreeCAD 即可确定性地测试投影与 Word 嵌入。 */
function boxMesh(origin: [number, number, number], size: [number, number, number], part: string, base: number): Mesh {
  const [x, y, z] = origin, [w, d, h] = size;
  return { vertices: [[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z], [x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]],
    triangles: ([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]] as [number, number, number][]).map(triangle => triangle.map(index => index + base) as [number, number, number]),
    parts: Array<string>(12).fill(part) };
}
export const testMesh: Mesh = boxMesh([0, 0, 0], [120, 60, 30], '1', 0);
/** 两个零件：底座 1 与放在其顶面的夹持座 2，用于测试按部件标号与遮挡。 */
const seat = boxMesh([40, 10, 30], [40, 40, 30], '2', 8);
export const testAssemblyMesh: Mesh = { vertices: [...testMesh.vertices, ...seat.vertices], triangles: [...testMesh.triangles, ...seat.triangles], parts: [...testMesh.parts!, ...seat.parts!] };
export const testCadScript = 'import Part\nfrom FreeCAD import Vector\n\ndef build_model():\n    # 1 轨道底座\n    base = Part.makeBox(120, 60, 14, Vector(0, 0, 0))\n    # 2 夹持座\n    seat = Part.makeBox(40, 40, 30, Vector(40, 10, 14))\n    # 3 锁紧螺栓\n    bolt = Part.makeCylinder(4, 20, Vector(60, 30, 44), Vector(0, 0, 1))\n    return {"1": base, "2": seat, "3": bolt}\n';
export const testCadLabels = [{ number: '1', name: '轨道底座', point: [60, 30, 15] as [number, number, number] }, { number: '2', name: '夹持座', point: [60, 30, 45] as [number, number, number] }];
export function makeCad(brief = makeBrief(), id = `cad-${brief.id}`): ProductCad {
  return signProductArtifact('cad', { id, briefId: brief.id, script: testCadScript, summary: '测试用底座与夹持座模型。', assumptions: ['尺寸为测试推定。'], labels: testCadLabels,
    keyStructure: { point: [60, 30, 45] as [number, number, number], radius: 24 },
    meshDigest: meshDigest(testAssemblyMesh), vertexCount: testAssemblyMesh.vertices.length, triangleCount: testAssemblyMesh.triangles.length, freecadVersion: 'test',
    views: renderCadViews(testAssemblyMesh, '测试', { point: [60, 30, 45], radius: 24 }), createdAt: when }, productConfig);
}
export const documentContent = { abstract: '本产品通过滑槽引导夹持座移动，并通过锁紧螺栓固定，适用于光伏组件安装。',
  claims: ['1. 一种带滑槽锁紧结构的光伏组件安装支架，包括轨道底座、夹持座和锁紧螺栓，其特征在于所述夹持座与所述轨道底座滑动配合。', '2. 根据权利要求1所述的光伏组件安装支架，其特征在于所述锁紧螺栓用于固定所述夹持座。'],
  technicalField: '本方案涉及光伏安装支承技术领域。', background: '安装支承时需要适配不同的组件固定位置。', content: '设置轨道底座和可沿滑槽调节的夹持座，通过锁紧螺栓锁定。',
  drawings: '图1为本产品的结构示意图，1为轨道底座，2为夹持座，3为锁紧螺栓。', embodiment: '参照图1，轨道底座固定在安装面。夹持座沿滑槽移动后，通过锁紧螺栓锁紧。' };
export function makeMaterials(brief = makeBrief()): ProductMaterials {
  return signProductArtifact('materials', { ...documentContent, briefId: brief.id, title: brief.design.title, createdAt: when }, productConfig);
}
export function makeWorkflow(complete = false, figures: 'cad' | 'image' = 'cad'): ProductWorkflow {
  const workflow = createProductWorkflow(productProject);
  workflow.review = makeReview(); workflow.brief = makeBrief(workflow.review); workflow.previews = makePreview(workflow.brief);
  if (complete) {
    workflow.confirmation = signProductArtifact('confirmation', { briefId: workflow.brief.id, previewId: workflow.previews.id, previewDigest: workflow.previews.digest, confirmedAt: when }, productConfig);
    workflow.materials = makeMaterials(workflow.brief);
    if (figures === 'cad') workflow.cad = makeCad(workflow.brief);
    else workflow.figures = { 'patent-structure': makeImage(workflow.brief, 'patent') };
  }
  return workflow;
}
export const jsonEnvelope = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
