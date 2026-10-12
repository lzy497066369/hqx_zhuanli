import { expect, test } from '@playwright/test';
import { initialProjects, makeDocument, makeUtilityMaterials } from '../src/data';
import { drawingFixture } from './fixtures/drawing';

test('材料门禁：旧绘图不能生成文案', () => {
  const project = { ...initialProjects.find(p => p.category === 'utility')!, name: '一种光伏组件安装支架' };
  expect(() => makeUtilityMaterials(project, drawingFixture())).toThrow(/Patent Structure Model/);
  expect(() => makeDocument({ ...project, utilityDrawing: drawingFixture() })).toThrow(/请先生成并校验 V2 文案/);
});
