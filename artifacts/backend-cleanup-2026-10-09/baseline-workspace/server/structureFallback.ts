import type { InnovationNameCandidate, ProductBrief } from '../src/features/utility/patentStructure.ts';
import type { StructureDraft } from '../src/features/utility/structureDraft.ts';

const clean = (value: string, fallback: string) => {
  const text = value.trim().slice(0, 36);
  return text || fallback;
};

function uniqueName(value: string, fallback: string, used: Set<string>) {
  const base = clean(value, fallback);
  let name = base;
  let serial = 2;
  while (used.has(name)) name = `${base}${serial++}`;
  used.add(name);
  return name;
}

/**
 * Deterministic last-resort skeleton. It is deliberately simple and explicit:
 * the same compiler and model validator still decide whether it is usable.
 */
export function buildFallbackStructureDraft(brief: ProductBrief, candidate: InnovationNameCandidate): StructureDraft {
  const used = new Set<string>();
  const productSubject = /光伏板|光伏组件|电池板/u.test(brief.productName)
    ? candidate.mainComponents.find(name => /光伏板|光伏组件|电池板|板体/u.test(name)) || `${brief.productName}主体`
    : candidate.mainComponents[0] || `${brief.productName}主体`;
  const first = uniqueName(productSubject, `${brief.productName}主体`, used);
  const second = uniqueName(candidate.mainComponents[1] || '连接支撑件', '连接支撑件', used);
  const innovation = uniqueName('创新结构组件', '创新结构组件', used);
  const problemSolved = clean(candidate.solvedProblem, `改善${brief.productName}的结构使用问题`);
  const innovationPoint = clean(candidate.coreInnovationStructure || candidate.innovationDirection, '通过新增结构组件改善产品功能');
  const workingPrinciple = `${first}作为主体承载结构，${second}与其固定连接并支撑${innovation}；${innovation}依据“${innovationPoint}”实现相应功能。`;

  return {
    version: 1,
    title: candidate.name,
    technicalField: `本实用新型涉及${brief.productName}的结构装配技术领域。`,
    baseStructure: `${first}、${second}和${innovation}依次装配形成主体结构，${innovation}设置在${second}的作用位置。`,
    components: [
      { id: 'D01', name: first, kind: 'base', purpose: '构成产品从外部可见的主体', position: '整体结构中心的主体位置', whyNeeded: '用于明确产品主体并承载其余部件', visualFeature: /光伏板|光伏组件|电池板|板体/u.test(first) ? '长方形薄板，正面为板面主体' : '产品主体的外部可见轮廓', geometry: { shape: 'box', position: [-80, -40, 0], size: [160, 80, 20], rotation: [0, 0, 0] } },
      { id: 'D02', name: second, kind: 'base', purpose: '连接并支撑功能部件', position: '主体结构的连接位置', whyNeeded: '用于建立主体与创新结构之间的安装关系', visualFeature: '位于主体边缘或背面的连接支撑件轮廓', geometry: { shape: 'box', position: [-40, -20, 20], size: [80, 40, 60], rotation: [0, 0, 0] } },
      { id: 'D03', name: innovation, kind: 'innovation', purpose: '实现确认名称对应的结构功能', position: '连接支撑件的作用位置', whyNeeded: `用于解决${problemSolved}`, visualFeature: '与主体连接的创新结构轮廓', geometry: { shape: 'box', position: [-30, -15, 80], size: [60, 30, 20], rotation: [0, 0, 0] } },
    ],
    relationships: [
      { id: 'R01', from: 'D01', to: 'D02', relation: 'fixed_to', description: `${second}固定连接在${first}上。` },
      { id: 'R02', from: 'D02', to: 'D03', relation: 'connected_to', description: `${innovation}连接在${second}上。` },
    ],
    motions: [
      { id: 'M01', componentId: 'D01', type: 'static', path: '固定于主体安装位置', purpose: '保持整体结构稳定' },
      { id: 'M02', componentId: 'D02', type: 'static', path: '固定于主体结构上', purpose: '保持连接和支撑关系' },
      { id: 'M03', componentId: 'D03', type: 'static', path: '固定于连接支撑件上', purpose: '保持创新结构的作用位置' },
    ],
    innovationPoints: [innovationPoint],
    problemSolved,
    workingPrinciple,
    nextDraftNumber: 4,
    nextModelNumber: 1,
  };
}
