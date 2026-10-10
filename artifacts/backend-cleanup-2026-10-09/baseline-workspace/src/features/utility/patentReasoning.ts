import type { EvidenceItem, EvidencePackage, PriorArtStructureRelation } from './patentEvidence';
import { buildPriorArtRelations, validateEvidenceReferences } from './patentEvidence';
import type { PatentStructureModel } from './patentStructure';
import { getModelVersion } from './patentStructure';

export type ReasoningChain = {
  id: string;
  causeEvidenceRefs: string[];
  solutionFeatureIds: string[];
  priorArtRelationIds: string[];
  featureId: string;
  status: 'SUPPORTED' | 'ORPHAN_FEATURE' | 'UNSUPPORTED';
  technicalProblem: string;
  problemCause: string;
  problemCauseStatus: 'INFERRED';
  /** Prior-art context only; never support for user-owned structural facts. */
  priorArtEvidenceRefs: string[];
  solutionFeatures: string[];
  structuralMechanism: string;
  workingSteps: string[];
  technicalEffects: string[];
  effectIds: string[];
  evidenceRefs: string[];
  componentRefs: string[];
  relationRefs: string[];
  motionRefs: string[];
  confidence: number;
};

export type ReasonedEffect = {
  status: 'SUPPORTED';
  reasoningChainIds: string[];
  effectId: string;
  statement: string;
  componentIds: string[];
  relationIds: string[];
  motionIds: string[];
  evidenceRefs: string[];
};

export type ReasoningPackage = {
  priorArtRelations: PriorArtStructureRelation[];
  version: 1;
  modelVersion: string;
  chains: ReasoningChain[];
  technicalProblem: string;
  problemCause: string;
  problemCauseStatus: 'INFERRED';
  /** Prior-art context only; never support for user-owned structural facts. */
  priorArtEvidenceRefs: string[];
  solutionFeatures: string[];
  structuralMechanism: string[];
  workingSteps: string[];
  technicalEffects: string[];
  effects: ReasonedEffect[];
  evidenceRefs: string[];
  componentRefs: string[];
  relationRefs: string[];
  motionRefs: string[];
  confidence: number;
};

const unique = (items: string[]) => [...new Set(items)];
const hasClaimedNumber = (text: string) => /\d+(?:\.\d+)?\s*(?:%|％|mm|cm|kg|毫米|厘米|千克|倍|小时|分钟)/iu.test(text);
const causeFor = (problem: string, component: PatentStructureModel['components'][number], sources: EvidenceItem[], comparisons: PriorArtStructureRelation[]) => {
  if (!sources.length) return `针对“${problem}”尚无可引用证据，不能判定“${component.name}”的问题原因。`;
  const basis = sources.slice(0, 4).map(item => `${item.id}（${item.evidenceScope || item.sourceType}）摘录：“${item.extractedFact.slice(0, 160)}”`).join('；');
  const contrast = comparisons.find(relation => relation.relationType === 'DISTINGUISHED_FROM');
  const hypothesis = contrast && /调节|位移|间距|位置调整/u.test(problem)
    ? `根据对照关系 ${contrast.id}：若该固定连接承担用户要求的相对位置调节，则固定约束可能限制该调节；用户确认的滑动连接提供相对位移关系，但不据此证明已实现性能改善。`
    : `将“${component.name}”的既有配置与问题进行对照；当前资料不足以判定具体问题原因，不自行补造缺失机构。`;
  return `针对用户问题“${problem}”，以${basis}为依据。${hypothesis}因果关系为 INFERRED、尚未验证，不是已证明的现有技术缺陷或技术效果。`;
};

/** A deterministic causal record. User-confirmed structure is not proof of performance. */
export function buildReasoningPackage(model: PatentStructureModel, evidence?: EvidencePackage): ReasoningPackage {
  if (evidence) {
    const errors = validateEvidenceReferences(model, evidence);
    if (errors.length) throw new Error(`证据关联无效：${errors.join('；')}`);
  }
  const priorArtRelations = evidence ? buildPriorArtRelations(model, evidence) : [];
  const priorArt = evidence?.items.filter(item => item.sourceType === 'PATENT' &&
    ['CITED_ASSISTANT_SUMMARY', 'SEARCH_SNIPPET'].includes(item.evidenceScope || '') && item.status === 'INFERRED') || [];
  const priorArtEvidenceRefs = priorArt.map(item => item.id);
  const byId = new Map(evidence?.items.map(item => [item.id, item]));
  const chains = model.components.map(component => {
    const relations = model.connections.filter(link => link.from === component.id || link.to === component.id);
    const motions = model.motions.filter(motion => motion.componentId === component.id || motion.drivenBy === component.id);
    const refs = unique([...(component.evidenceRefs || []), ...relations.flatMap(link => link.evidenceRefs || []), ...motions.flatMap(motion => motion.evidenceRefs || [])]);
    const reliable = refs.map(id => byId.get(id)).filter(item => item && (item.status === 'USER_CONFIRMED' || item.status === 'SUPPORTED'));
    const comparisons = priorArtRelations.filter(relation => relation.structureComponentIds.includes(component.id));
    const chainPriorArtRefs = unique(comparisons.map(relation => relation.priorArtFeatureId));
    const causeEvidenceRefs = unique([...reliable.map(item => item!.id), ...chainPriorArtRefs]);
    const structuralMechanism = relations.map(link => `${link.id}：${link.from} ${link.relation} ${link.to}；${link.description}`).join('；');
    // Static paths describe an operating state, not fabricated movement.
    const workingSteps = motions.filter(motion => motion.path.trim()).map(motion => `${motion.id}：${motion.componentId}，${motion.type}，${motion.path}`);
    const connected = relations.length > 0;
    const status = !connected ? 'ORPHAN_FEATURE' : reliable.length && component.evidenceRefs?.some(id => reliable.some(item => item?.id === id))
      ? 'SUPPORTED' : 'UNSUPPORTED';
    // whyNeeded is a proposed rationale, not an experimentally verified effect.
    // A confirmed component proves its presence, not the outcome in whyNeeded.
    // Only a separately sourced effect, tied to the same mechanism, is assertable.
    const effectSources = status === 'SUPPORTED' && connected && !!structuralMechanism && workingSteps.length > 0
      ? refs.map(id => byId.get(id)).filter(item => item && item.status === 'SUPPORTED' &&
          item.factType === 'EFFECT' && item.originalText &&
          item.originalText.includes(component.name) &&
          relations.some(link => item.relatedConnectionIds.includes(link.id) && !!link.description.trim() && item.originalText!.includes(link.description)) &&
          motions.some(motion => !!motion.path.trim() && item.originalText!.includes(motion.path)) && item.relatedComponentIds.includes(component.id) &&
          (item.relatedConnectionIds.some(id => relations.some(link => link.id === id)) ||
           item.relatedMotionIds.some(id => motions.some(motion => motion.id === id))) &&
          !!component.whyNeeded.trim() && item.fact.includes(component.whyNeeded.trim()) && !hasClaimedNumber(item.fact) &&
          !/^(?:提高|提升|改善|增强)(?:稳定性|效率|可靠性)$|^延长寿命$/u.test(item.fact.trim()))
        .map(item => item!)
      : [];
    const effects = effectSources.map(item => ({
      effectId: `EFFECT-${item.id}`,
      statement: item.fact,
      componentIds: item.relatedComponentIds,
      relationIds: item.relatedConnectionIds,
      motionIds: item.relatedMotionIds,
      evidenceRefs: [item.id],
    }));
    return {
      id: `CHAIN-${component.id}`, causeEvidenceRefs, solutionFeatureIds: [component.id, ...relations.map(link => link.id), ...motions.map(motion => motion.id)],
      priorArtRelationIds: comparisons.map(relation => relation.id),
      featureId: component.id, status, technicalProblem: model.problemSolved,
      problemCause: causeFor(model.problemSolved, component, causeEvidenceRefs.map(id => byId.get(id)!), comparisons), priorArtEvidenceRefs: chainPriorArtRefs, problemCauseStatus: 'INFERRED',
      solutionFeatures: [component.name],
      structuralMechanism, workingSteps,
      technicalEffects: effects.map(value => value.statement), effectIds: effects.map(value => value.effectId),
      evidenceRefs: unique([...refs, ...chainPriorArtRefs]), componentRefs: unique([component.id, ...relations.flatMap(link => [link.from, link.to])]),
      relationRefs: relations.map(link => link.id), motionRefs: motions.map(motion => motion.id),
      confidence: status === 'SUPPORTED' ? Math.min(...reliable.map(item => item!.confidence)) : 0,
    } satisfies ReasoningChain;
  });
  const supported = chains.filter(chain => chain.status === 'SUPPORTED');
  const effects = unique(supported.flatMap(chain => chain.effectIds)).map(id => {
    const item = evidence!.items.find(value => `EFFECT-${value.id}` === id)!;
    return {
      status: 'SUPPORTED' as const, reasoningChainIds: supported.filter(chain => chain.effectIds.includes(id)).map(chain => chain.id),
      effectId: id, statement: item.fact, componentIds: item.relatedComponentIds,
      relationIds: item.relatedConnectionIds, motionIds: item.relatedMotionIds, evidenceRefs: [item.id],
    };
  });
  return {
    priorArtRelations, version: 1, modelVersion: getModelVersion(model), chains,
    technicalProblem: model.problemSolved,
    problemCause: chains.map(chain => chain.problemCause).join('；').slice(0, 3000) || '针对用户需求提出的问题原因推理尚需验证。',
    priorArtEvidenceRefs,
    problemCauseStatus: 'INFERRED',
    solutionFeatures: unique(supported.flatMap(chain => chain.solutionFeatures)),
    structuralMechanism: unique(supported.map(chain => chain.structuralMechanism).filter(Boolean)),
    workingSteps: unique(supported.flatMap(chain => chain.workingSteps)),
    technicalEffects: effects.map(value => value.statement), effects,
    evidenceRefs: unique(supported.flatMap(chain => chain.evidenceRefs)),
    componentRefs: unique(supported.flatMap(chain => chain.componentRefs)),
    relationRefs: unique(supported.flatMap(chain => chain.relationRefs)),
    motionRefs: unique(supported.flatMap(chain => chain.motionRefs)),
    confidence: supported.length ? Math.min(...supported.map(chain => chain.confidence)) : 0,
  };
}
