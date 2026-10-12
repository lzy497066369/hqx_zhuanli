import type { StructureDraft } from '../../src/features/utility/structureDraft';
import type { StructureSkeleton } from '../../src/features/utility/structureSkeleton';

export function sampleDraft(title: string, innovationName = '快拆罩'): StructureDraft {
  return {
    version: 1, title, technicalField: '机械装配技术领域', baseStructure: `壳体连接支架，支架连接${innovationName}。`,
    components: [
      { id: 'D01', name: '壳体', kind: 'base', purpose: '承载', position: '主体', whyNeeded: '固定支架', geometry: { shape: 'box', position: [0, 0, 0], size: [120, 80, 40], rotation: [0, 0, 0] } },
      { id: 'D02', name: '支架', kind: 'base', purpose: '连接', position: '壳体上', whyNeeded: '支撑罩体', geometry: { shape: 'box', position: [20, 0, 40], size: [60, 40, 60], rotation: [0, 0, 0] } },
      { id: 'D03', name: innovationName, kind: 'innovation', purpose: '可拆防护', position: '支架上', whyNeeded: '便于维护', geometry: { shape: 'box', position: [15, -5, 100], size: [70, 50, 20], rotation: [0, 0, 0] } },
    ],
    relationships: [
      { id: 'R01', from: 'D01', to: 'D02', relation: 'fixed_to', description: '支架固定在壳体上' },
      { id: 'R02', from: 'D02', to: 'D03', relation: 'connected_to', description: `${innovationName}连接在支架上` },
    ],
    motions: [
      { id: 'M01', componentId: 'D01', type: 'static', path: '固定', purpose: '承载' },
      { id: 'M02', componentId: 'D02', type: 'static', path: '固定', purpose: '连接' },
      { id: 'M03', componentId: 'D03', type: 'static', path: '安装位置固定', purpose: '防护' },
    ],
    innovationPoints: [`${innovationName}通过支架连接`], problemSolved: '便于维护', workingPrinciple: `${innovationName}连接支架并提供防护。`,
    nextDraftNumber: 4, nextModelNumber: 1,
  };
}

export function sampleSkeleton(title: string, innovationName = '快拆罩'): StructureSkeleton {
  return {
    version: 1, title, visualSubject: '壳体为整体可见主体', subjectComponent: '壳体', summary: '拟议部件和连接，待实物核对。', problemSolved: '便于维护', innovationPoints: [`${innovationName}通过支架连接`],
    components: [
      { name: '壳体', kind: 'base', purpose: '承载', position: '主体', visualFeature: '方形壳体', geometryShape: 'box', geometry: { shape: 'box', position: [0, 0, 0], size: [120, 80, 40], rotation: [0, 0, 0] } },
      { name: '支架', kind: 'base', purpose: '连接', position: '壳体上', visualFeature: '直角支撑件', geometryShape: 'box', geometry: { shape: 'box', position: [20, 0, 40], size: [60, 40, 60], rotation: [0, 0, 0] } },
      { name: innovationName, kind: 'innovation', purpose: '可拆防护', position: '支架上', visualFeature: '可拆罩体', geometryShape: 'box', geometry: { shape: 'box', position: [15, -5, 100], size: [70, 50, 20], rotation: [0, 0, 0] } },
    ],
    relationships: [
      { from: '壳体', to: '支架', relation: 'fixed_to', description: '支架固定在壳体上' },
      { from: '支架', to: innovationName, relation: 'connected_to', description: `${innovationName}连接在支架上` },
    ], motions: [],
  };
}
