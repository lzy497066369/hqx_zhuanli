import type { Project } from '../../data';
import type { InnovationNameCandidate, ProductBrief } from './patentStructure';
import { isInnovationNameCandidate, isProductBrief } from './patentStructure';
import { selectedStructureEvidence } from './structureEvidence';

export function namingStructureInput(project: Project): { brief: ProductBrief; candidate: InnovationNameCandidate } | null {
  const naming = project.naming;
  if (!naming?.confirmed || naming.selectedName !== project.name) return null;
  const name = project.name.trim();
  const profile = naming.profile;
  const product = profile.product.trim() || naming.candidates.find(item => item.name === name)?.product.trim() || name.replace(/^一种/u, '');
  const feature = profile.features.trim() || naming.candidates.find(item => item.name === name)?.feature.trim() || name;
  const evidence = naming.structureSelection?.confirmed ? selectedStructureEvidence(naming.structureSelection) : [];
  const evidenceText = (category: string) => evidence.filter(option => option.category === category).map(option => `${option.label}：${option.detail}`).join('；');
  const brief: ProductBrief = {
    productName: product,
    introduction: profile.business.trim(),
    usageScene: evidenceText('relationship'),
    existingStructure: [profile.features.trim(), evidenceText('component'), evidenceText('geometry')].filter(Boolean).join('\n'),
    existingFunctions: evidenceText('motion'),
    improvementType: profile.improvementType,
    structureEvidence: naming.structureSelection?.confirmed ? naming.structureSelection : undefined,
  };
  const candidate: InnovationNameCandidate = {
    id: 'confirmed-name', name, innovationDirection: feature,
    solvedProblem: `围绕${name}的结构主题，具体问题须以实际结构为准。`,
    coreInnovationStructure: `已确认名称：${name}；已提供结构特征：${profile.features.trim() || '未提供'}。`,
    mainComponents: [product],
    implementation: '仅依据已确认名称和现有资料提出结构草案；未提供的连接、运动和尺寸不得视为已核实事实。',
  };
  return isProductBrief(brief) && isInnovationNameCandidate(candidate) ? { brief, candidate } : null;
}
