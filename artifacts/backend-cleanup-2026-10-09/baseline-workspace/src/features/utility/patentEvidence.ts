import type { PatentStructureModel, ProductBrief } from './patentStructure';
import { isResponsesQueryCoverage, factMatchesOriginalPage, isVerifiedPatentSource, evidenceScopes, isPatentResearch, isSourcedPatentResearchFact, patentUrl } from './patentResearch';
import type { PatentResearch, PatentResearchFact, ResearchEvidenceScope, ResearchFactType } from './patentResearch';

export type EvidenceSourceType = 'USER_INPUT' | 'USER_FILE' | 'PRODUCT_DOCUMENT' | 'PATENT' | 'OFFICIAL_SOURCE' | 'STANDARD' | 'PAPER' | 'WEB_SOURCE' | 'AI_INFERENCE';
export type EvidenceStatus = 'USER_CONFIRMED' | 'SUPPORTED' | 'INFERRED' | 'UNSUPPORTED' | 'CONFLICT';
export type EvidenceItem = {
  id: string;
  citationId?: string;
  sourceRefs?: string[];
  citationRefs?: string[];
  researchFactId?: string;
  sourceType: EvidenceSourceType;
  sourceTitle: string;
  sourceUrl?: string;
  sourceReference?: string;
  sourceDate?: string;
  sourceAuthority?: string;
  originalText?: string;
  sourceId?: string;
  factType?: ResearchFactType;
  evidenceScope?: ResearchEvidenceScope;
  relatedFigureIds?: string[];
  notes?: string;
  fact: string;
  extractedFact: string;
  relatedComponentIds: string[];
  relatedConnectionIds: string[];
  relatedMotionIds: string[];
  confidence: number;
  status: EvidenceStatus;
};
export type PatentResearchPackage = {
  query: string;
  queries: string[];
  sources: PatentResearch['sources'];
  evidence: string[];
  priorArtFeatures: string[];
  technicalTerms: string[];
  facts?: PatentResearchFact[];
  researchSummary: string;
  retrievedAt: string;
  queryCoverage?: PatentResearch['queryCoverage'];
};
/** Comparison records, never provenance for user-owned structure. */
export type PriorArtStructureRelation = {
  id: string;
  priorArtFeatureId: string;
  structureComponentIds: string[];
  structureConnectionIds: string[];
  structureMotionIds: string[];
  relationType: 'ADDRESSES_PROBLEM' | 'DISTINGUISHED_FROM' | 'IMPROVES' | 'COMBINES' | 'MODIFIES' | 'NOT_PRESENT_IN_PRIOR_ART';
  problem: string;
  difference: string;
  reason: string;
  evidenceRefs: string[];
  status: 'INFERRED';
};
export type EvidencePackage = { version: 1; modelVersion: string; items: EvidenceItem[]; research?: PatentResearchPackage; priorArtRelations?: PriorArtStructureRelation[] };

/** Conservative lexical comparison. No absence, novelty or improvement is inferred from a summary. */
export function buildPriorArtRelations(model: PatentStructureModel, pkg: EvidencePackage): PriorArtStructureRelation[] {
  const relations: PriorArtStructureRelation[] = [];
  for (const item of pkg.items.filter(item => item.sourceType === 'PATENT' && item.status !== 'UNSUPPORTED' && item.status !== 'CONFLICT')) {
    for (const component of model.components) {
      if (!item.extractedFact.includes(component.name) || !component.evidenceRefs?.length) continue;
      const links = model.connections.filter(link => link.from === component.id || link.to === component.id);
      const motions = model.motions.filter(motion => motion.componentId === component.id);
      // A positive fixed-connection statement can be contrasted with a confirmed sliding relation.
      // Never infer 'not present' from search silence or a truncated summary.
      const contrast = links.find(link => link.relation === 'slidably_connected' &&
        item.extractedFact.split(/[。；;\n]/u).some(sentence =>
          !/不|未|无|非/u.test(sentence) && /固定连接|固定于/u.test(sentence) &&
          [link.from, link.to].every(id => sentence.includes(model.components.find(part => part.id === id)!.name))));
      const refs = [...new Set([item.id, ...component.evidenceRefs, ...links.flatMap(link => link.evidenceRefs || []), ...motions.flatMap(motion => motion.evidenceRefs || [])])];
      relations.push({
        id: `PAR-${String(relations.length + 1).padStart(3, '0')}`, priorArtFeatureId: item.id,
        structureComponentIds: [component.id], structureConnectionIds: links.map(link => link.id), structureMotionIds: motions.map(motion => motion.id),
        relationType: contrast ? 'DISTINGUISHED_FROM' : 'ADDRESSES_PROBLEM', problem: model.problemSolved,
        difference: `${contrast ? `待验证的关系差异：资料描述固定连接，用户确认 ${contrast.id} 为滑动连接；` : '待核对差异：'}检索资料记载“${item.extractedFact}”；用户确认“${component.name}：${component.purpose}；${component.position}”。仅列出对照内容，不认定缺失、新颖性或性能改善。`,
        reason: `以共同术语“${component.name}”关联用户问题与结构；证据范围 ${item.evidenceScope}，关系为待验证推断，不是结构来源。`,
        evidenceRefs: refs, status: 'INFERRED',
      });
    }
  }
  return relations;
}

const sources: EvidenceSourceType[] = ['USER_INPUT', 'USER_FILE', 'PRODUCT_DOCUMENT', 'PATENT', 'OFFICIAL_SOURCE', 'STANDARD', 'PAPER', 'WEB_SOURCE', 'AI_INFERENCE'];
const statuses: EvidenceStatus[] = ['USER_CONFIRMED', 'SUPPORTED', 'INFERRED', 'UNSUPPORTED', 'CONFLICT'];
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const ids = (value: unknown, pattern: RegExp) => Array.isArray(value) && value.length <= 80 && value.every(item => typeof item === 'string' && pattern.test(item)) && new Set(value).size === value.length;
const factTypes: ResearchFactType[] = ['TECHNICAL_FEATURE', 'STRUCTURAL_RELATION', 'MOTION_RELATION', 'PROBLEM', 'EFFECT', 'MATERIAL', 'PARAMETER', 'OTHER', 'PRIOR_ART_FEATURE'];
const sourceTypes = new Set<EvidenceSourceType>(['USER_FILE', 'PRODUCT_DOCUMENT', 'PATENT', 'OFFICIAL_SOURCE', 'STANDARD', 'PAPER', 'WEB_SOURCE']);
const publicationId = /^[A-Z]{2}\d{4,16}[A-Z]\d?$/u;
const refs = (value: unknown, max: number, pattern?: RegExp) => Array.isArray(value) && value.length >= 1 && value.length <= max &&
  value.every(item => typeof item === 'string' && text(item, 200) && (!pattern || pattern.test(item))) && new Set(value).size === value.length;

export function isEvidencePackage(value: unknown): value is EvidencePackage {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as EvidencePackage;
  if (pkg.version !== 1 || !text(pkg.modelVersion, 120) || !Array.isArray(pkg.items) || pkg.items.length > 150 ||
      new Set(pkg.items.map(item => item?.id)).size !== pkg.items.length) return false;
  if (pkg.research !== undefined) {
    const r = pkg.research;
    if ((r.queryCoverage !== undefined && !isResponsesQueryCoverage(r.queryCoverage, r.queries?.length)) || !text(r.query, 2200) || !Array.isArray(r.queries) || r.queries.length === 0 || r.queries.length > 10 ||
        !r.queries.every(item => text(item, 1000)) || !text(r.researchSummary, 12000) || !text(r.retrievedAt, 100) || !Number.isFinite(Date.parse(r.retrievedAt)) ||
        !Array.isArray(r.sources) || !Array.isArray(r.evidence) || !Array.isArray(r.priorArtFeatures) || !Array.isArray(r.technicalTerms) ||
        r.sources.length > 5 || new Set(r.sources.map(source => source?.publication)).size !== r.sources.length ||
        !r.sources.every(source => {
          const canonical = patentUrl(source?.url);
          return !!canonical && canonical.url === source.url && canonical.publication === source.publication &&
            text(source.title, 500) && ['search_result', 'opened'].includes(source.evidence) &&
            (source.originalPage === undefined || isVerifiedPatentSource(source));
        }) ||
        r.evidence.length > 20 || r.priorArtFeatures.length > 20 || r.technicalTerms.length > 40 ||
        (r.facts !== undefined && (!Array.isArray(r.facts) || r.facts.length > 20 || !r.facts.every(isSourcedPatentResearchFact) || new Set(r.facts.map(fact => fact.id)).size !== r.facts.length ||
          !r.facts.every(fact => {
            const sourceRefs = fact.sourceRefs || [fact.sourceId];
            const citationRefs = fact.citationRefs || (fact.citationId ? [fact.citationId] : []);
            return (fact.evidenceScope !== 'PATENT_ORIGINAL_TEXT' || factMatchesOriginalPage(fact, r.sources)) && sourceRefs.every(ref => r.sources.some(source => source.publication === ref)) &&
              sourceRefs.includes(fact.sourceId) && (!fact.citationId || citationRefs.includes(fact.citationId));
          }))) ||
        ![...r.evidence, ...r.priorArtFeatures, ...r.technicalTerms].every(item => text(item, 2000))) return false;
  }
  if (pkg.priorArtRelations !== undefined && (!Array.isArray(pkg.priorArtRelations) || pkg.priorArtRelations.length > 1500 ||
      new Set(pkg.priorArtRelations.map(relation => relation?.id)).size !== pkg.priorArtRelations.length ||
      !pkg.priorArtRelations.every(relation => relation && /^PAR-\d{3,4}$/u.test(relation.id) &&
        /^EVID-\d{3}$/u.test(relation.priorArtFeatureId) && relation.status === 'INFERRED' &&
        ['ADDRESSES_PROBLEM', 'DISTINGUISHED_FROM', 'IMPROVES', 'COMBINES', 'MODIFIES', 'NOT_PRESENT_IN_PRIOR_ART'].includes(relation.relationType) &&
        text(relation.problem, 12000) && text(relation.difference, 12000) && text(relation.reason, 3000) &&
        ids(relation.structureComponentIds, /^C\d{2,3}$/u) && ids(relation.structureConnectionIds, /^R\d{2,3}$/u) &&
        ids(relation.structureMotionIds, /^M\d{2,3}$/u) && ids(relation.evidenceRefs, /^EVID-\d{3}$/u)))) return false;
  return pkg.items.every(item => !!item && /^EVID-\d{3}$/u.test(item.id) && sources.includes(item.sourceType) &&
    statuses.includes(item.status) && text(item.sourceTitle, 500) && text(item.fact, 3000) && text(item.extractedFact, 3000) &&
    (item.sourceUrl === undefined || (text(item.sourceUrl, 1000) && /^https:\/\//u.test(item.sourceUrl))) &&
    (item.sourceDate === undefined || text(item.sourceDate, 100)) && (item.sourceAuthority === undefined || text(item.sourceAuthority, 500)) &&
    (item.originalText === undefined || text(item.originalText, 12000)) &&
    (item.sourceId === undefined || text(item.sourceId, 120)) &&
    (item.sourceRefs === undefined || refs(item.sourceRefs, 5, publicationId)) &&
    (item.citationId === undefined || text(item.citationId, 200)) &&
    (item.citationRefs === undefined || refs(item.citationRefs, 10)) &&
    (item.researchFactId === undefined || /^RSF-\d{3}$/u.test(item.researchFactId)) &&
    (item.sourceReference === undefined || text(item.sourceReference, 1000)) &&
    (item.factType === undefined || factTypes.includes(item.factType)) &&
    (item.evidenceScope === undefined || evidenceScopes.includes(item.evidenceScope)) &&
    (item.relatedFigureIds === undefined || ids(item.relatedFigureIds, /^F\d{2,3}$/u)) &&
    (item.notes === undefined || text(item.notes, 1000)) &&
    ids(item.relatedComponentIds, /^C\d{2,3}$/u) && ids(item.relatedConnectionIds, /^R\d{2,3}$/u) &&
    ids(item.relatedMotionIds, /^M\d{2,3}$/u) && typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1 &&
    !(item.sourceType === 'AI_INFERENCE' && ['SUPPORTED', 'USER_CONFIRMED'].includes(item.status)) &&
    !(item.status === 'USER_CONFIRMED' && item.sourceType !== 'USER_INPUT') &&
    !(item.status === 'SUPPORTED' && (!sourceTypes.has(item.sourceType) || !item.sourceId ||
      !(item.sourceUrl || item.sourceReference) || !item.originalText || !item.evidenceScope ||
      !item.originalText.includes(item.fact) || !item.originalText.includes(item.extractedFact) ||
      // Patent provenance never upgrades a prior-art fact into a supported user-product fact.
      item.sourceType === 'PATENT' ||
      (item.sourceType === 'USER_FILE' ? item.evidenceScope !== 'USER_PROVIDED' : item.evidenceScope !== 'DOCUMENT_EXCERPT'))) &&
    !(['CITED_ASSISTANT_SUMMARY', 'SEARCH_SNIPPET'].includes(item.evidenceScope || '') && item.status !== 'INFERRED') &&
    !(item.sourceType === 'PATENT' && (
      !item.sourceUrl || !item.sourceId || patentUrl(item.sourceUrl)?.publication !== item.sourceId || item.factType !== 'PRIOR_ART_FEATURE' ||
      !['CITED_ASSISTANT_SUMMARY', 'SEARCH_SNIPPET', 'PATENT_ORIGINAL_TEXT'].includes(item.evidenceScope || '') ||
      item.status !== 'INFERRED' ||
      (item.evidenceScope === 'PATENT_ORIGINAL_TEXT' && (!pkg.research?.facts || !item.researchFactId ||
        !item.originalText?.includes(item.extractedFact) || item.fact !== item.extractedFact)) ||
      (item.sourceRefs !== undefined && !item.sourceRefs.includes(item.sourceId)) ||
      (item.citationId !== undefined && (!item.citationRefs || !item.citationRefs.includes(item.citationId))) ||
      (item.evidenceScope === 'SEARCH_SNIPPET' && (!item.citationId || !item.citationRefs?.includes(item.citationId))) ||
      item.relatedComponentIds.length !== 0 || item.relatedConnectionIds.length !== 0 ||
      item.relatedMotionIds.length !== 0 || item.relatedFigureIds?.length !== 0
    ))) &&
    (pkg.research?.facts === undefined || pkg.items.filter(item => item.sourceType === 'PATENT').length === pkg.research.facts.length) &&
    new Set(pkg.items.filter(item => item.sourceType === 'PATENT' && item.evidenceScope === 'PATENT_ORIGINAL_TEXT')
      .map(item => item.researchFactId)).size === pkg.items.filter(item => item.sourceType === 'PATENT' && item.evidenceScope === 'PATENT_ORIGINAL_TEXT').length &&
    (pkg.research?.facts === undefined || pkg.items.filter(item => item.sourceType === 'PATENT').every(item => {
      const fact = pkg.research!.facts!.find(value => value.id === item.researchFactId) || pkg.research!.facts!.find(value =>
        value.sourceId === item.sourceId && value.sourceUrl === item.sourceUrl && value.originalText === item.originalText && value.extractedFact === item.extractedFact);
      if (!fact) return false;
      const factSourceRefs = fact.sourceRefs || [fact.sourceId];
      const itemSourceRefs = item.sourceRefs || [item.sourceId];
      const factCitationRefs = fact.citationRefs || (fact.citationId ? [fact.citationId] : []);
      const itemCitationRefs = item.citationRefs || (item.citationId ? [item.citationId] : []);
      return (!item.researchFactId || item.researchFactId === fact.id) &&
        item.sourceId === fact.sourceId && item.sourceUrl === fact.sourceUrl && item.sourceTitle === fact.sourceTitle &&
        item.originalText === fact.originalText && item.extractedFact === fact.extractedFact && item.fact === fact.extractedFact &&
        item.evidenceScope === fact.evidenceScope && item.factType === fact.factType && item.status === fact.status &&
        item.confidence === fact.confidence &&
        JSON.stringify(itemSourceRefs) === JSON.stringify(factSourceRefs) &&
        JSON.stringify(itemCitationRefs) === JSON.stringify(factCitationRefs) &&
        item.citationId === fact.citationId;
    }));
}

/** Validates both directions of the model/evidence graph, including stale IDs. */
export function validateEvidenceReferences(model: PatentStructureModel, pkg: EvidencePackage): string[] {
  const errors: string[] = [];
  if (!isEvidencePackage(pkg)) return ['证据包格式无效'];
  if (pkg.modelVersion !== (model.modelVersion || 'legacy-model')) errors.push('证据包与结构模型版本不一致');
  if (pkg.priorArtRelations !== undefined && JSON.stringify(pkg.priorArtRelations) !== JSON.stringify(buildPriorArtRelations(model, pkg))) errors.push('现有技术对照关系与证据/确认结构不一致');
  const items = new Map(pkg.items.map(item => [item.id, item]));
  const check = (kind: 'component' | 'connection' | 'motion', id: string, refs?: string[]) => {
    for (const ref of refs || []) {
      const item = items.get(ref);
      const target = kind === 'component' ? item?.relatedComponentIds : kind === 'connection' ? item?.relatedConnectionIds : item?.relatedMotionIds;
      if (!target?.includes(id)) errors.push(`${id} 的证据引用 ${ref} 无对应关联`);
    }
  };
  model.components.forEach(value => check('component', value.id, value.evidenceRefs));
  model.connections.forEach(value => check('connection', value.id, value.evidenceRefs));
  model.motions.forEach(value => check('motion', value.id, value.evidenceRefs));
  for (const item of pkg.items) {
    if (item.relatedComponentIds.some(id => !model.components.some(value => value.id === id)) ||
        item.relatedConnectionIds.some(id => !model.connections.some(value => value.id === id)) ||
        item.relatedMotionIds.some(id => !model.motions.some(value => value.id === id))) errors.push(`${item.id} 指向不存在的结构`);
    for (const [targets, values] of [
      [item.relatedComponentIds, model.components],
      [item.relatedConnectionIds, model.connections],
      [item.relatedMotionIds, model.motions],
    ] as const) {
      for (const id of targets) if (!values.find(value => value.id === id)?.evidenceRefs?.includes(item.id)) {
        errors.push(`${item.id} 到 ${id} 缺少反向证据引用`);
      }
    }
  }
  return errors;
}

/**
 * Confirms a proposed structure from user-confirmed material. Prior-art facts
 * remain provenance for problem and difference reasoning and never evidence
 * for the user's components, connections or motions.
 */
export function confirmStructureEvidence(model: PatentStructureModel, brief: ProductBrief, research?: PatentResearch): { model: PatentStructureModel; evidence: EvidencePackage } {
  const items: EvidenceItem[] = [];
  const add = (fact: string, relatedComponentIds: string[], relatedConnectionIds: string[], relatedMotionIds: string[], sourceTitle: string) => {
    const id = `EVID-${String(items.length + 1).padStart(3, '0')}`;
    items.push({ id, sourceType: 'USER_INPUT', sourceTitle, evidenceScope: 'USER_PROVIDED', fact, extractedFact: fact, relatedComponentIds, relatedConnectionIds, relatedMotionIds, confidence: 1, status: 'USER_CONFIRMED' });
    return id;
  };
  for (const fact of brief.confirmedFacts || []) {
    const id = add(`${fact.question}：${fact.answer}`, [], [], [], fact.origin ? '用户采纳的 AI 建议' : '用户提供的结构资料');
    if (fact.origin === 'model_proposal') {
      const item = items.find(value => value.id === id)!;
      item.sourceType = 'AI_INFERENCE';
      item.status = 'INFERRED';
      item.evidenceScope = 'INFERRED';
      item.confidence = 0.5;
    }
  }
  const components = model.components.map(component => ({ ...component, evidenceRefs: [add(`${component.name}：${component.purpose}；${component.position}`, [component.id], [], [], '用户确认的结构骨架')] }));
  const connections = model.connections.map(connection => ({ ...connection, evidenceRefs: [add(`${connection.from}与${connection.to}：${connection.relation}；${connection.description}`, [], [connection.id], [], '用户确认的连接关系')] }));
  const motions = model.motions.map(motion => ({ ...motion, evidenceRefs: [add(`${motion.componentId}：${motion.type}；${motion.path}`, [], [], [motion.id], '用户确认的运动关系')] }));
  const confirmed = { ...model, components, connections, motions };
  const evidence: EvidencePackage = { version: 1, modelVersion: model.modelVersion || 'legacy-model', items };
  if (research) {
    const priorArt = buildResearchEvidence(research, evidence.modelVersion);
    evidence.research = priorArt.research;
    for (const item of priorArt.items) {
      items.push({ ...item, id: `EVID-${String(items.length + 1).padStart(3, '0')}` });
    }
  }
  evidence.priorArtRelations = buildPriorArtRelations(confirmed, evidence);
  return { model: confirmed, evidence };
}

/** Same EvidencePackage before and after compilation; no research-owned model IDs. */
export function buildResearchEvidence(research: PatentResearch, modelVersion = 'research-pending'): EvidencePackage {
  if (!isPatentResearch(research)) throw new Error('Research 来源或事实协议无效');
  const facts = (research.facts || []).filter(isSourcedPatentResearchFact);
  const items: EvidenceItem[] = facts.map((fact, index) => ({
    id: `EVID-${String(index + 1).padStart(3, '0')}`,
    researchFactId: fact.id,
    ...(fact.citationId ? { citationId: fact.citationId } : {}),
    ...(fact.sourceRefs ? { sourceRefs: fact.sourceRefs } : {}),
    ...(fact.citationRefs ? { citationRefs: fact.citationRefs } : {}),
    sourceType: 'PATENT', sourceId: fact.sourceId, sourceTitle: fact.sourceTitle, sourceUrl: fact.sourceUrl,
    originalText: fact.originalText, fact: fact.extractedFact, extractedFact: fact.extractedFact,
    factType: fact.factType, evidenceScope: fact.evidenceScope, confidence: fact.confidence, status: fact.status,
    relatedComponentIds: [], relatedConnectionIds: [], relatedMotionIds: [], relatedFigureIds: [], notes: fact.notes,
  }));
  const pkg: EvidencePackage = { version: 1, modelVersion, items, research: {
    query: research.query, queries: research.queries, sources: research.sources,
    evidence: facts.map(fact => fact.extractedFact), priorArtFeatures: facts.map(fact => fact.extractedFact),
    technicalTerms: [...new Set(facts.flatMap(fact => fact.extractedFact.match(/[\p{Script=Han}]{2,8}(?:组件|机构|装置|支架|连接件)/gu) || []))].slice(0, 40),
    facts, researchSummary: research.summary, retrievedAt: research.searchedAt,
    ...(research.queryCoverage ? { queryCoverage: research.queryCoverage } : {}),
  } };
  if (!isEvidencePackage(pkg)) throw new Error('Research Evidence 格式或来源无效');
  return pkg;
}
