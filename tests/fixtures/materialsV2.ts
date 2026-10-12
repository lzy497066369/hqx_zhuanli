import type { UtilityMaterials } from '../../src/data';
import type { PatentGenerationContext } from '../../src/features/utility/claimPlan';
import { getModelVersion } from '../../src/features/utility/patentStructure';
import { generationDocumentSnapshot, generationSnapshot } from '../../src/features/utility/patentPackage';

// UI transport fixture only; production pipeline execution is tested separately.
export function withTestGenerationProof(materials: UtilityMaterials, context: PatentGenerationContext): UtilityMaterials {
  return { ...materials, generationProof: {
    version: 1, contextSnapshot: generationSnapshot(context), documentSnapshot: generationDocumentSnapshot(materials),
    reviews: [{ issues: [], fixedIssueIds: [] }, { issues: [], fixedIssueIds: [] }],
    polish: { before: 'test-only-unchanged', after: 'test-only-unchanged' },
    validation: { readyForExport: true, issues: [], qualityScore: 100, qualityThreshold: 75 },
  } };
}

export function materialsForContext(context: PatentGenerationContext): UtilityMaterials {
  const { model, claimPlan } = context;
  const part = (id: string) => {
    const item = model.components.find(value => value.id === id)!;
    return `${item.name}（${item.referenceNo}）`;
  };
  const verbs = { connected_to: '连接', fixed_to: '固定连接', slidably_connected: '滑动连接', rotatably_connected: '转动连接', driven_by: '驱动', supported_by: '支撑', limited_by: '限位' };
  const relation = (id: string) => {
    const link = model.connections.find(value => value.id === id)!;
    return `${part(link.from)}与${part(link.to)}${verbs[link.relation]}`;
  };
  const claims = claimPlan.claims.map(claim => {
    const features = [...claim.componentIds.map(part), ...claim.connectionIds.map(relation)];
    return `${claim.claimNo}. ${claim.parentClaimNo ? `根据权利要求${claim.parentClaimNo}所述的${model.productTitle}` : model.productTitle}，其特征在于：包括${features.join('、')}。`;
  });
  return withTestGenerationProof({
    version: 1, generationSource: 'materials-v2', generatedAt: new Date().toISOString(),
    sourceModelVersion: getModelVersion(model),
    abstract: `本实用新型公开${model.productTitle}，包括${model.components.map(item => part(item.id)).join('、')}。`,
    claims: claims.join('\n'),
    technicalField: `本实用新型涉及${model.technicalField}。`,
    background: `现有技术中，${model.productTitle}的结构配置需要结合具体使用场景核对。`,
    content: `本实用新型提供${model.productTitle}。${model.connections.map(link => relation(link.id)).join('；')}。`,
    drawings: model.figureSpecs.map((figure, index) => `图${index + 1}为${figure.title.replace(/[。；]+$/u, '')}。`).join('\n'),
    embodiment: `在具体实施方式中，${model.components.map(item => part(item.id)).join('、')}依照结构模型配置。${model.connections.map(link => relation(link.id)).join('；')}。`,
    claimReferences: claimPlan.claims.map(({ claimNo, parentClaimNo, componentIds, connectionIds, motionIds }) =>
      ({ claimNo, parentClaimNo, componentIds, connectionIds, motionIds })),
  }, context);
}
