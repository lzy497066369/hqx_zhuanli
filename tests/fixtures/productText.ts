import { signProductArtifact } from '../../server/productProof';
import { briefTextVersion, designFromTechnicalPlan } from '../../server/productTextAi';
import { TEXT_RULES_VERSION, technicalPlanForWriting, textSourceVersion, documentContent } from '../../src/features/product/productText';
import { renderProductDescription } from '../../src/features/product/productWorkflow';
import type { TechnicalPlan, TextDocument, StructureReview } from '../../src/features/product/productText';
import { makeDesign, makeReview, makeBrief, productConfig, productSelection } from './productWorkflow';

export const emptyStructureReview = (): StructureReview => ({ partEdits: [], patches: [], findings: [], unresolved: [] });
export const emptyTextReview = () => ({ patches: [], findings: [], unresolved: [] });
export function makeTechnicalPlan(selection = productSelection): TechnicalPlan {
  const d = makeDesign(selection);
  return {
    schemaVersion: 3, title: d.title, scenario: d.useCase, problem: '调节夹持位置时需要先松开固定连接', goal: '允许夹持位置沿轨道调节后固定',
    technicalField: d.technicalField, overview: d.overview, appearance: d.appearance, choiceCoverage: d.choiceCoverage,
    focus: { improvement: d.innovation, corePartIds: ['1', '2', '3'], boundary: '仅处理位置调节及锁定' },
    parts: d.components.map(p => ({ id: p.number, name: p.name, kind: 'part', parentId: null, importance: 'core', necessity: p.purpose,
      role: p.purpose, position: p.structure, motion: p.connection })),
    connections: [{ from: '1', to: '2', type: '滑动配合', detail: '夹持座沿轨道底座的滑槽移动' }, { from: '2', to: '3', type: '螺纹紧固', detail: '锁紧螺栓穿过夹持座并与轨道底座的滑槽内螺纹件配合' }],
    coreActions: [{ name: '调节与锁紧', partIds: ['1', '2', '3'], trigger: '旋松锁紧螺栓', before: '夹持座被锁定于轨道底座', constraint: '滑槽限制横向偏移，螺栓旋松后解除压紧',
      sequence: ['旋松锁紧螺栓', '沿滑槽移动夹持座', '旋紧锁紧螺栓'], after: '夹持座相对轨道底座固定', clearance: '滑槽沿纵向保持移动路径', basis: '滑动导向与可解除的螺纹压紧连接配合' }],
    workingSteps: [{ step: d.workingPrinciple, partIds: ['1', '2', '3'] }],
    improvements: [{ mechanism: '滑槽导向且螺栓解除或施加压紧', effect: '便于调整并固定位置', partIds: ['1', '2', '3'] }],
    claimPlan: { focus: d.title, independent: [{ feature: '轨道底座与夹持座滑动配合，锁紧螺栓锁定夹持座', partIds: ['1', '2', '3'], reason: '缺少导向或锁紧配合不能调节后保持位置' }], dependent: [], embodimentOnly: [] },
    assumptions: ['内部设计选择记录，不进入正文'], verificationNeeds: ['测量样件承载与滑动阻力'],
  };
}
export function makeTextDocument(title = productSelection.proposedName): TextDocument {
  return { title, abstract: '本实用新型涉及光伏组件安装支架，轨道底座与夹持座滑动配合，锁紧螺栓旋松时可调节夹持座位置，旋紧后固定，便于适配安装位置。',
    claims: [{ number: 1, dependsOn: null, text: '一种带滑槽锁紧结构的光伏组件安装支架，包括轨道底座（1）和夹持座（2），其特征在于：所述夹持座（2）与所述轨道底座（1）滑动配合，锁紧螺栓（3）穿过所述夹持座（2）并与所述轨道底座（1）的滑槽内螺纹件配合。', partIds: ['1', '2', '3'] }],
    technicalField: '本实用新型涉及光伏组件安装支承技术领域。', background: '安装组件时，固定式支承可能难以适配不同的安装位置。', technicalProblem: '提供能够调节并固定夹持位置的安装支架。',
    solution: '轨道底座（1）设置滑槽，夹持座（2）与滑槽滑动配合，锁紧螺栓（3）穿过夹持座（2）连接于滑槽内的螺纹件。',
    benefits: ['滑槽引导夹持座移动，锁紧螺栓在旋紧后保持调节位置，便于适配安装位置。'],
    embodiment: '轨道底座（1）固定于安装面，夹持座（2）通过滑槽限制横向偏移。锁紧螺栓（3）穿过夹持座（2）并与滑槽内螺纹件配合，旋紧后将夹持座（2）压紧于轨道底座（1）。',
    operation: '旋松锁紧螺栓（3），沿滑槽移动夹持座（2）至需要的位置，再旋紧锁紧螺栓（3）。' };
}
export function makeTextStructure(review = makeReview()) {
  return signProductArtifact('text-structure', { reviewId: review.id, rulesVersion: TEXT_RULES_VERSION, plan: makeTechnicalPlan(review.selection), createdAt: '2026-10-14T01:00:00.000Z' }, productConfig);
}
export function makeTextDraft(brief = makeBrief()) {
  return signProductArtifact('text-draft', { briefId: brief.id, sourceVersion: briefTextVersion(brief), document: makeTextDocument(brief.design.title), createdAt: '2026-10-14T01:00:00.000Z' }, productConfig);
}
export function makeTextBrief(review = makeReview(), id = 'brief-text-1') {
  const plan = makeTechnicalPlan(review.selection), design = designFromTechnicalPlan(plan);
  return signProductArtifact('brief', { id, reviewId: review.id, selection: review.selection, design, description: renderProductDescription(design),
    technicalSource: { version: textSourceVersion(technicalPlanForWriting(plan)), initialPlan: structuredClone(plan), plan, review: emptyStructureReview() }, createdAt: '2026-10-14T01:00:00.000Z' }, productConfig);
}
export function makeTextMaterials(brief = makeTextBrief()) {
  const doc = makeTextDocument(brief.design.title);
  return signProductArtifact('materials', { ...documentContent(doc), drawings: '图1为本产品的立体图。', briefId: brief.id, title: brief.design.title,
    createdAt: '2026-10-14T01:00:00.000Z', textRecord: { sourceVersion: briefTextVersion(brief), draft: doc, review: emptyTextReview(), document: doc, status: 'completed' as const } }, productConfig);
}
