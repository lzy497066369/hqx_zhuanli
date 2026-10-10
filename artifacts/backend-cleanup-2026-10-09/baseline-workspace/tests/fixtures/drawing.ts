import { CONTENT_MODEL_REVISION, drawingSource, parseGeometry } from '../../src/features/utility/contentDrawing';
import type { UtilityDrawing } from '../../src/data';

export const bracketTitle = '一种光伏组件安装支架';
export const bracketGeometry = `底板 | 长方体 | 0,0,0 | 160,100,8
左支撑 | 长方体 | 10,20,8 | 10,60,72
右支撑 | 长方体 | 130,20,8 | 10,60,72
安装板 | 长方体 | 0,0,80 | 160,100,6`;
export const bracketStructure = '底板上方设置左右两个支撑，两个支撑的上端连接安装板。';
export const jointTitle = '一种管道密封接头';
export const jointGeometry = `管状本体 | 圆管 | 0,0,0 | 16,60,11
端部密封环 | 圆管 | 0,0,60 | 16,4,11`;
export const jointStructure = '管状本体的端部设置密封环，两部件同轴连接，内部形成贯通通道。';
export function drawingFixture(title = bracketTitle, geometryText = bracketGeometry, structure = bracketStructure): UtilityDrawing {
  const components = parseGeometry(geometryText).components;
  const drawing: UtilityDrawing = { version: 1, technicalField: '产品安装结构', structure, workingPrinciple: '支撑连接两个承载面。', geometryText, parts: components.map(p => ({ id: p.id, name: p.name })), updatedAt: '2026-09-22T08:00:00.000Z' };
  drawing.design = { revision: CONTENT_MODEL_REVISION, title, source: drawingSource(title, drawing), components, detailPartId: 2, generatedAt: drawing.updatedAt };
  return drawing;
}
