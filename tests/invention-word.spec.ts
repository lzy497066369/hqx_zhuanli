import { expect, test } from '@playwright/test';
import { makeInventionMaterials, validateInventionMaterials } from '../src/features/invention/invention';
import type { InventionFacts } from '../src/features/invention/invention';

const legacyFacts: InventionFacts = {
  technicalField: '纺织面料技术领域', background: '已有面料整理时固着不足。', problem: '改善整理剂在面料上的固着',
  solution: '采用预处理、浸轧及后处理工序', steps: '水洗坯布并烘干\n对坯布进行浸轧处理', limitations: '浸轧处理采用两次浸轧',
  effects: '两次浸轧使整理剂接触坯布表面', embodiment: '实施例一：将坯布水洗后烘干，再进行两次浸轧和后处理。', confirmed: true,
};

test('发明旧规则仍可校验历史草稿，但不再作为新流程入口', () => {
  const materials = makeInventionMaterials('一种面料整理方法', legacyFacts);
  expect(() => validateInventionMaterials('一种面料整理方法', legacyFacts, materials)).not.toThrow();
  expect(() => validateInventionMaterials('一种面料整理方法', { ...legacyFacts, steps: `${legacyFacts.steps}\n新增步骤` }, materials)).toThrow('不一致');
});

test('发明从属项支持链式和分支引用', () => {
  const facts = { ...legacyFacts, limitations: '根据权利要求1所述：先进行预固定\n根据权利要求2所述：再进行热压\n根据权利要求1所述：采用指定温度' };
  const materials = makeInventionMaterials('一种面料整理方法', facts);
  expect(materials.claims.slice(1).map(claim => claim.match(/根据权利要求(\d+)所述/u)?.[1])).toEqual(['1', '2', '1']);
  expect(() => validateInventionMaterials('一种面料整理方法', facts, materials)).not.toThrow();
});
