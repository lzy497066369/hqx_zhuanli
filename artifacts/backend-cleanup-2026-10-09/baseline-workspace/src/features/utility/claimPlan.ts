import type { EvidencePackage } from './patentEvidence';
import type { PatentStructureModel } from './patentStructure';
import { getModelVersion } from './patentStructure';
import { validateEvidenceReferences } from './patentEvidence';
import type { ReasoningPackage } from './patentReasoning';

const unique = (items: string[]) => [...new Set(items)];

export type PlannedClaim = {
  claimNo: number;
  parentClaimNo?: number;
  purpose: string;
  componentIds: string[];
  connectionIds: string[];
  motionIds: string[];
  evidenceRefs: string[];
};
export type ClaimPlan = { version: 1; modelVersion: string; claims: PlannedClaim[] };
export type PatentGenerationContext = {
  model: PatentStructureModel;
  evidence: EvidencePackage;
  reasoning: ReasoningPackage;
  claimPlan: ClaimPlan;
  research?: EvidencePackage['research'];
};

/** Claim references are a closed set; text generators may not expand it. */
export function generateClaimPlan(model: PatentStructureModel, evidence: EvidencePackage, reasoning: ReasoningPackage): ClaimPlan {
  const version = getModelVersion(model);
  if (evidence.modelVersion !== version || reasoning.modelVersion !== version) throw new Error('生成上下文的结构版本不一致');
  const invalid = validateEvidenceReferences(model, evidence);
  if (invalid.length) throw new Error(`证据关联无效：${invalid.join('；')}`);
  const supported = new Set(reasoning.chains.filter(chain => chain.status === 'SUPPORTED').map(chain => chain.featureId));
  const bases = model.components.filter(part => part.kind === 'base' && supported.has(part.id));
  const innovations = model.components.filter(part => part.kind === 'innovation' && supported.has(part.id));
  const anchor = bases[0];
  const necessary = new Set<string>(anchor ? [anchor.id] : []);
  const necessaryLinks = new Set<string>();
  // A shortest, stable path connects each supported innovation to the confirmed base.
  // Peripheral base parts are not independent-claim features merely by being 'base'.
  for (const innovation of innovations) {
    if (!anchor) break;
    const queue: Array<{ id: string; path: string[]; links: string[] }> = [{ id: anchor.id, path: [anchor.id], links: [] }];
    const visited = new Set([anchor.id]);
    while (queue.length) {
      const step = queue.shift()!;
      if (step.id === innovation.id) {
        step.path.forEach(id => necessary.add(id));
        step.links.forEach(id => necessaryLinks.add(id));
        break;
      }
      for (const link of model.connections) {
        const next = link.from === step.id ? link.to : link.to === step.id ? link.from : undefined;
        if (next && supported.has(next) && !visited.has(next)) {
          visited.add(next);
          queue.push({ id: next, path: [...step.path, next], links: [...step.links, link.id] });
        }
      }
    }
    if (!necessary.has(innovation.id)) throw new Error(`${innovation.id} 与核心基础结构之间缺少受支持的连接路径`);
  }
  if (!innovations.length && anchor) {
    const link = model.connections.find(value => value.from === anchor.id || value.to === anchor.id);
    if (link) {
      necessary.add(link.from);
      necessary.add(link.to);
      necessaryLinks.add(link.id);
    }
  }
  const core = model.components.filter(part => necessary.has(part.id));
  const ids = new Set(core.map(part => part.id));
  const connections = model.connections.filter(link => necessaryLinks.has(link.id));
  const refs = (values: Array<{ evidenceRefs?: string[] }>) => [...new Set(values.flatMap(value => value.evidenceRefs || []))];
  if (core.length === 0 || connections.length === 0) throw new Error('权利要求规划缺少闭合的主体和连接关系');
  const claims: PlannedClaim[] = [{ claimNo: 1, purpose: unique(core.map(part => part.purpose)).join('；'), componentIds: core.map(part => part.id), connectionIds: connections.map(link => link.id), motionIds: [], evidenceRefs: refs([...core, ...connections]) }];
  for (const motion of model.motions.filter(value => ids.has(value.componentId) && value.type !== 'static').slice(0, 7)) {
    claims.push({ claimNo: claims.length + 1, parentClaimNo: 1, purpose: motion.purpose, componentIds: [motion.componentId], connectionIds: [], motionIds: [motion.id], evidenceRefs: refs([motion]) });
  }
  return { version: 1, modelVersion: version, claims };
}

export function createPatentGenerationContext(model: PatentStructureModel, evidence: EvidencePackage, reasoning: ReasoningPackage): PatentGenerationContext {
  return { model, evidence, reasoning, claimPlan: generateClaimPlan(model, evidence, reasoning), research: evidence.research };
}
