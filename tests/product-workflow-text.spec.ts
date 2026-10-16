import { test, expect } from '@playwright/test';
import { createProductWorkflowService, PRODUCT_PATHS } from '../server/productWorkflowAi';
import { createProductTextService, designFromTechnicalPlan, writingSource, briefTextVersion } from '../server/productTextAi';
import { signProductArtifact } from '../server/productProof';
import {
  applyTechnicalReview, applyDocumentReview, applyTextPatches, checkTechnicalPlan, checkTextDocument,
  technicalPlanForWriting, documentForWriting, documentContent, isFrozenTechnicalSource, textSourceVersion, isTextRecord,
} from '../src/features/product/productText';
import type { TechnicalPlan, TextDocument } from '../src/features/product/productText';
import { hasCurrentText, isProductBrief, isProductMaterials, isProductWorkflow, productDocumentText } from '../src/features/product/productWorkflow';
import { makeBrief, makeReview, makeWorkflow, productConfig, productSelection, jsonEnvelope } from './fixtures/productWorkflow';
import { makeTechnicalPlan, makeTextDocument, makeTextStructure, makeTextDraft, emptyStructureReview, emptyTextReview } from './fixtures/productText';

const signal = () => new AbortController().signal;
function renumber(p: TechnicalPlan, from: string, to: string) {
  for (const part of p.parts) { if (part.id === from) part.id = to; if (part.parentId === from) part.parentId = to; }
  for (const c of p.connections) { if (c.from === from) c.from = to; if (c.to === from) c.to = to; }
  p.focus.corePartIds = p.focus.corePartIds.map(n => n === from ? to : n);
  for (const items of [p.coreActions, p.workingSteps, p.improvements, p.claimPlan.independent, p.claimPlan.dependent, p.claimPlan.embodimentOnly]) for (const item of items) item.partIds = item.partIds.map(n => n === from ? to : n);
}
function mockResponses(outputs: unknown[]) {
  const calls: { system: string; input: any }[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push({ system: request.messages[0].content, input: JSON.parse(request.messages[1].content) });
    if (!outputs.length) throw new Error('Unexpected model request');
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    return jsonEnvelope(next);
  };
  return { fetcher, calls };
}
async function frozenBrief() {
  const { fetcher } = mockResponses([emptyStructureReview()]);
  return createProductTextService(productConfig, fetcher).brief(makeReview(), makeTextStructure(), signal());
}

test('稳定部件编号支持重排与空缺，复核不会改到相邻部件', () => {
  const source = makeTechnicalPlan(); renumber(source, '3', '7'); source.parts.reverse();
  const before = structuredClone(source);
  const result = applyTechnicalReview(source, { ...emptyStructureReview(), partEdits: [{ op: 'update', partId: '7', partName: '锁紧螺栓', changes: { position: '从夹持座上方穿入' } }] });
  expect(result.parts.find(p => p.id === '7')!.position).toBe('从夹持座上方穿入');
  expect(result.parts.find(p => p.id === '2')).toEqual(source.parts.find(p => p.id === '2'));
  expect(checkTechnicalPlan(result, productSelection)).toEqual([]); expect(source).toEqual(before);
  expect(designFromTechnicalPlan(result).components.map(p => p.number)).toEqual(['7', '2', '1']);
});

test('编号名称不匹配、数组下标或整表补丁均拒绝整轮，不保留部分修改', () => {
  const source = makeTechnicalPlan(), before = structuredClone(source);
  const valid = { op: 'update', partId: '1', partName: '轨道底座', changes: { position: '新位置' } };
  expect(() => applyTechnicalReview(source, { ...emptyStructureReview(), partEdits: [valid, { ...valid, partId: '2' }] })).toThrow(/整轮/);
  for (const path of ['/parts', '/parts/1/position', '/parts/-', '/__proto__/x', '/problem', '/goal', '/schemaVersion']) {
    expect(() => applyTechnicalReview(source, { ...emptyStructureReview(), partEdits: [valid], patches: [{ op: 'replace', path, value: [] }] })).toThrow();
  }
  expect(source).toEqual(before);
});

test('增删和改名必须同步引用，孔槽归属实体而不是独立CAD实体', () => {
  const source = makeTechnicalPlan();
  expect(() => applyTechnicalReview(source, { ...emptyStructureReview(), partEdits: [{ op: 'remove', partId: '3', partName: '锁紧螺栓' }] })).toThrow(/引用|连接/);
  expect(() => applyTechnicalReview(source, { ...emptyStructureReview(), partEdits: [{ op: 'update', partId: '2', partName: '夹持座', changes: { name: '活动座' } }] })).toThrow(/旧术语/);
  const added = applyTechnicalReview(source, { ...emptyStructureReview(), partEdits: [{ op: 'add', partId: '8', partName: '导向槽', value: {
    id: '8', name: '导向槽', kind: 'opening', parentId: '1', importance: 'support', necessity: '提供导向路径', role: '导向', position: '沿轨道底座纵向延伸', motion: '相对轨道底座固定',
  } }] });
  expect(checkTechnicalPlan(added)).toEqual([]);
  const design = designFromTechnicalPlan(added);
  expect(design.components.map(p => p.number)).toEqual(['1', '2', '3']);
  expect(design.components[0].structure).toContain('导向槽');
  const deleted = applyTechnicalReview(added, { ...emptyStructureReview(), partEdits: [{ op: 'remove', partId: '8', partName: '导向槽' }] });
  expect(deleted).toEqual(source);
  added.parts.find(p => p.id === '8')!.parentId = null;
  expect(checkTechnicalPlan(added).join()).toContain('所属部件');
});

test('明确的通用名与具体形式映射允许合理分层，任意同义词和重复身份不通过', () => {
  const source = makeTechnicalPlan(), doc = makeTextDocument();
  source.parts[0].form = { name: '燕尾轨道底座', detail: '轨道底座具有燕尾截面导向槽', basis: '滑动导向的必要关系由轨道底座和配合面支持，燕尾截面是进一步限定' };
  const specific = { ...doc, embodiment: doc.embodiment.replaceAll('轨道底座（1）', '燕尾轨道底座（1）') };
  expect(checkTextDocument(specific, source)).toEqual([]);
  expect(checkTextDocument({ ...doc, embodiment: '基台（1）设置于安装面。' }, source).join()).toContain('登记名称');
  source.parts[1].form = { ...source.parts[0].form, name: '轨道底座' };
  expect(checkTechnicalPlan(source).join()).toContain('多个部件');
});

test('正文白名单保留真实尺寸与布局，排除所有层级设计记录；文本补丁不能改结构或夹带记录', () => {
  const plan: any = makeTechnicalPlan(); plan.parts[0].position += '，槽长20毫米'; plan.parts[0].privateNote = 'PRIVATE_PART_NOTE';
  plan.connections[0].reviewLog = 'PRIVATE_CONNECTION_LOG'; plan.assumptions = ['PRIVATE_ASSUMPTION']; plan.claimPlan.independent[0].reason = 'PRIVATE_REASON';
  const writing = JSON.stringify(technicalPlanForWriting(plan));
  expect(writing).toContain('20毫米'); expect(writing).not.toContain('PRIVATE_');
  const doc = makeTextDocument();
  expect(documentForWriting({ ...doc, notes: 'PRIVATE_RECORD' } as TextDocument)).toEqual(doc);
  for (const patch of [{ op: 'add', path: '/notes', value: 'x' }, { op: 'replace', path: '/parts', value: [] },
    { op: 'add', path: '/claims/0/reviewNote', value: 'x' }, { op: 'replace', path: '/claims/00/text', value: 'x' }]) {
    expect(() => applyDocumentReview(doc, { ...emptyTextReview(), patches: [patch] }, plan)).toThrow();
  }
  expect(() => applyTextPatches(doc, [{ op: 'add', path: '/claims/__proto__/x', value: true }], ['claims'])).toThrow();
  expect(doc).toEqual(makeTextDocument());
});

test('一项独立权利要求有效；摘要、标号清单、引用文字和图号由程序核对', () => {
  const doc = makeTextDocument(), plan = makeTechnicalPlan(); expect(checkTextDocument(doc, plan)).toEqual([]);
  expect(checkTextDocument({ ...doc, abstract: '字'.repeat(301) }, plan).join()).toContain('300');
  expect(checkTextDocument({ ...doc, operation: '如图1所示，拉动夹持座（2）。' }, plan).join()).toContain('图号');
  expect(checkTextDocument({ ...doc, claims: [{ ...doc.claims[0], partIds: ['1'] }] }, plan).join()).toContain('partIds');
  const claims = [...doc.claims, { number: 2, dependsOn: 1, text: '根据权利要求3所述的支架，其特征在于：轨道底座（1）为长条形。', partIds: ['1'] }];
  expect(checkTextDocument({ ...doc, claims }, plan).join()).toContain('文字引用');
});

test('模型重写整条权利要求时JSON键顺序不影响复核记录的持久化读取', () => {
  const draft = makeTextDocument(), first = draft.claims[0];
  const review = { ...emptyTextReview(), patches: [{ op: 'replace' as const, path: '/claims/0', value: { text: first.text, partIds: first.partIds, dependsOn: null, number: 1 } }] };
  const document = applyDocumentReview(draft, review, makeTechnicalPlan());
  expect(isTextRecord(JSON.parse(JSON.stringify({ sourceVersion: 'a'.repeat(64), draft, review, document, status: 'completed' })))).toBe(true);
});

test('主应用四个阶段只以冻结技术依据写正文，结构和文本复核自动修正一次', async () => {
  const position = '沿安装面纵向设置，滑槽朝上';
  const response = mockResponses([makeTechnicalPlan(), { ...emptyStructureReview(), patches: [{ op: 'replace', path: '/parts/0/position', value: position }] },
    { ...emptyStructureReview(), partEdits: [{ op: 'update', partId: '1', partName: '轨道底座', changes: { position } }] }, makeTextDocument(),
    { ...emptyTextReview(), patches: [{ op: 'add', path: '/verificationNeeds', value: ['内部事项'] }] }, emptyTextReview()]);
  const service = createProductTextService(productConfig, response.fetcher), review = makeReview();
  const structure = await service.structure(review, signal());
  const brief = await service.brief(review, structure, signal()); expect(isProductBrief(brief)).toBe(true);
  const draft = await service.draft(brief, signal());
  const result = await service.materials(brief, draft, signal());
  expect(result.textRecord.status).toBe('completed'); expect(response.calls).toHaveLength(6);
  expect(response.calls[2].system).toContain('partEdits');
  for (const call of response.calls.slice(3)) {
    expect(call.input.plan.parts[0].position).toBe(position);
    expect(JSON.stringify(call.input)).not.toContain('assumptions'); expect(JSON.stringify(call.input)).not.toContain('内部设计选择');
  }
  expect(brief.technicalSource!.plan.assumptions).toEqual(makeTechnicalPlan().assumptions);
});

test('中断后通过已签名检查点只重做受影响阶段，重启服务也可续跑', async () => {
  const first = mockResponses([makeTechnicalPlan()]);
  const structure = await createProductTextService(productConfig, first.fetcher).structure(makeReview(), signal());
  const second = mockResponses([emptyStructureReview(), makeTextDocument()]);
  const resumed = createProductTextService(productConfig, second.fetcher);
  const brief = await resumed.brief(makeReview(), structure, signal());
  const draft = await resumed.draft(brief, signal());
  const last = mockResponses([emptyTextReview()]);
  const completed = await createProductTextService(productConfig, last.fetcher).materials(brief, draft, signal());
  expect(completed.textRecord.status).toBe('completed'); expect(second.calls).toHaveLength(2); expect(last.calls).toHaveLength(1);
  const invalid = structuredClone(structure); invalid.plan.parts[0].position = '篡改';
  await expect(resumed.brief(makeReview(), invalid, signal())).rejects.toMatchObject({ code: 'PRODUCT_PROOF_INVALID' });
});

test('技术资料变化或草稿属于另一版本时禁止复用，保留旧对象用于历史查看', async () => {
  const brief = await frozenBrief(), old = structuredClone(brief), draft = makeTextDraft(brief);
  const plan = brief.technicalSource!.plan;
  plan.parts[0].position = '新的安装位置';
  expect(isFrozenTechnicalSource(brief.technicalSource)).toBe(false);
  expect(() => briefTextVersion(brief)).toThrow('技术依据版本');
  const next = { ...old, id: 'new-brief' };
  const client = createProductTextService(productConfig, async () => { throw new Error('must not call'); });
  await expect(client.materials(next, draft, signal())).rejects.toMatchObject({ code: 'PRODUCT_TEXT_STALE' });
  expect(isProductBrief(old)).toBe(true);
  expect(textSourceVersion(technicalPlanForWriting(plan))).not.toBe(old.technicalSource!.version);
});

test('文本待复核状态保留正文与发现，纯文字导出及既有Word字段不含设计记录', async () => {
  const workflow = makeWorkflow(true), brief = await frozenBrief();
  const response = mockResponses([{ ...emptyTextReview(), unresolved: ['需进一步核对从属特征的支持范围'] }]);
  const result = await createProductTextService(productConfig, response.fetcher).materials(brief, makeTextDraft(brief), signal());
  const materials = signProductArtifact('materials', { ...result, drawings: workflow.materials!.drawings, briefId: brief.id, title: brief.design.title, createdAt: '2026-10-14T01:00:00.000Z' }, productConfig);
  expect(isProductMaterials(materials)).toBe(true); expect(materials.textRecord.status).toBe('needs_review');
  workflow.brief = { ...brief, id: workflow.brief!.id }; workflow.materials = { ...materials, briefId: workflow.brief.id };
  expect(hasCurrentText(workflow)).toBe(true); expect(isProductWorkflow(workflow)).toBe(true);
  const output = productDocumentText(workflow);
  expect(output).toContain('具体实施方式'); expect(output).not.toContain('产品简介'); expect(output).not.toContain('内部设计选择'); expect(output).not.toContain('需进一步核对');
  workflow.materials.textRecord!.sourceVersion = '0'.repeat(64);
  expect(hasCurrentText(workflow)).toBe(false); expect(() => productDocumentText(workflow)).toThrow();
});

test('历史简介不会在正文阶段重设计，旧任务仍可读取；新文本只读取已有技术字段', async () => {
  const brief: any = makeBrief(); brief.design.assumptions = ['PRIVATE_LEGACY_NOTE']; brief.description += '\nPRIVATE_DESCRIPTION_NOTE';
  const source = JSON.stringify(writingSource(brief)); expect(source).not.toContain('PRIVATE_'); expect(source).toContain('轨道底座');
  const response = mockResponses([makeTextDocument(), emptyTextReview()]);
  const result = await createProductTextService(productConfig, response.fetcher).materials(brief, undefined, signal());
  expect(result.textRecord.status).toBe('completed'); expect(response.calls).toHaveLength(2);
  expect(isProductWorkflow(makeWorkflow(true))).toBe(true);
  expect(() => productDocumentText(makeWorkflow(true))).not.toThrow();
});

test('生产接口注册结构和正文检查点；草稿仍受既有预览确认约束', async () => {
  const response = mockResponses([makeTechnicalPlan()]), service = createProductWorkflowService(productConfig, response.fetcher);
  const structure = await service(PRODUCT_PATHS.structure, { review: makeReview() }, signal());
  expect(structure).toMatchObject({ reviewId: makeReview().id });
  await expect(service(PRODUCT_PATHS.draft, { brief: makeBrief() }, signal())).rejects.toMatchObject({ code: 'PREVIEW_CONFIRMATION_REQUIRED' });
  expect(response.calls).toHaveLength(1);
});

test('声明字段或补丁中的严重结构矛盾不会进入正文，自动修复不掩盖未解决项', async () => {
  const response = mockResponses([{ ...emptyStructureReview(), unresolved: ['固定连接阻挡拆卸路径'] }]);
  const service = createProductTextService(productConfig, response.fetcher);
  await expect(service.brief(makeReview(), makeTextStructure(), signal())).rejects.toMatchObject({ code: 'PRODUCT_STRUCTURE_UNRESOLVED', details: ['固定连接阻挡拆卸路径'] });
  expect(response.calls).toHaveLength(1);
  expect(documentContent(makeTextDocument()).embodiment.match(/旋松锁紧螺栓/g)).toHaveLength(1);
});
