import { expect, test } from '@playwright/test';
import { sanitizeFinalPatentDocument } from '../src/features/utility/finalDocumentSanitizer';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { PATENT_FIGURES, FIGURE_LABELS, FIGURE_DESCRIPTIONS } from '../src/features/utility/drawingModel';
import type { UtilityMaterials } from '../src/data';
import { generateStructure, mockStructure, openNamedWorkspace, sampleDraft } from './fixtures/structureFlow';

function fixture() {
  const result = compileStructureDraft(sampleDraft('一种防护装置'));
  if (!result.success) throw new Error(result.errors.join('；'));
  const materials: UtilityMaterials = {
    version: 1, generatedAt: '', abstract: '一种防护装置，包括壳体、支架及快拆罩。',
    claims: '1. 一种防护装置，其特征在于：壳体连接支架。\n2. 根据权利要求1所述的防护装置，其特征在于：快拆罩设置于支架上。',
    technicalField: '机械装配技术领域', background: '防护装置用于机械装配。',
    content: 'AI备注：材料面板内部草稿', drawings: 'Evidence: E01/E03', embodiment: 'validation: 内部校验',
  };
  return { model: result.model, materials };
}

test('正式文档：按来源过滤独立备注，保留全部权利要求、结构事实和有效效果', () => {
  const { model, materials } = fixture();
  const expected = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  model.components[0].position += '（示意数量与位置，待核对）';
  model.components[1].whyNeeded += '。E01/E03 明确该部件来源。';
  model.components[2].purpose += '；标记为创新';
  model.baseStructure += '拟议结构，待实物核对。';
  model.workingPrinciple += '【AI分析：内部推理】';
  model.connections[0].description += '。AI备注：示意连接。';
  materials.abstract += '拟议结构，待实物核对。';
  materials.background += 'Evidence: E01。validation: 已检查。internal: 元数据。draft: 草稿。';
  materials.claims = materials.claims.replace('支架上。', '支架上（示意位置，待核对）。');
  const before = JSON.stringify({ model, materials });
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  expect(output).toEqual(expected);
  expect(JSON.stringify({ model, materials })).toBe(before);
  expect(Object.keys(output).sort()).toEqual(['abstract', 'claims', 'figures', 'sections', 'title']);
});

test('正式文档：合法型号、英文术语、括号内容及一般核对功能不误删', () => {
  const { model, materials } = fixture();
  const formal = 'E01/E03 型连接器用于传输信号，控制器提供 validation 模式和 draft angle 参数，显示屏显示“待核对”状态。';
  materials.abstract = formal;
  materials.background = '［E01］为连接器型号；Evidence 为显示器的界面标签。';
  materials.claims += '\n3. 根据权利要求1所述的防护装置，其特征在于：控制器包括 internal 接口和 E02 端口。';
  model.components[2].whyNeeded = '适配 E03 型连接器';
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  expect(output.abstract).toBe(formal);
  expect(output.claims).toEqual(materials.claims.split('\n'));
  expect(output.sections.find(section => section.title === '背景技术')?.paragraphs).toEqual([materials.background]);
  expect(JSON.stringify(output)).toContain('适配 E03 型连接器');
});

test('正式文档：只含内部信息的可选字段不产生空语句，必要字段缺失明确失败', () => {
  const { model, materials } = fixture();
  model.components[0].position = '示意位置，待核对';
  model.components[1].whyNeeded = 'E01/E03';
  model.components[2].whyNeeded = '从而 E01/E03 明确来源';
  model.connections[0].description = 'AI备注：连接待核对';
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  expect(JSON.stringify(output)).not.toMatch(/E01|E03|待核对|设置于。|从而。|，。/u);
  expect(output.claims).toHaveLength(2);
  expect(output.sections).toHaveLength(5);
  model.components[0].purpose = 'AI备注：作用未确认';
  expect(() => sanitizeFinalPatentDocument(model.productTitle, model, materials)).toThrow('C01.purpose');
});

test('正式文档：不得删除空权利要求或把待核对尺寸变成确定事实', () => {
  const { model, materials } = fixture();
  materials.claims = '1. 一种防护装置，其特征在于：所述壳体设置于示意位置，待核对。';
  expect(() => sanitizeFinalPatentDocument(model.productTitle, model, materials)).toThrow('权利要求1');
  materials.claims = '1. 一种防护装置，其特征在于：壳体长20mm（待核对）。';
  expect(() => sanitizeFinalPatentDocument(model.productTitle, model, materials)).toThrow('权利要求1');
});

test('正式文档：材料中的扩展技术内容、运动说明及附图说明逐段保留', () => {
  const { model, materials } = fixture();
  const content = ['壳体设有排水槽，排水槽与壳体的外侧连通。', '支架上的 E01 型连接器具有 validation 模式。'];
  const embodiment = ['安装时将快拆罩沿支架移入，随后锁定。', '维护时沿相反方向拆下快拆罩。'];
  const drawings = model.figureSpecs.map((figure, index) => `图${index + 1}为${figure.title}，标注部件：壳体、支架。`);
  drawings.push('局部放大目标为快拆罩与支架的连接位置。');
  materials.content = [...content, 'AI备注：内部草稿。'].join('\n');
  materials.embodiment = [...embodiment, 'validation: 内部验证。'].join('\n');
  materials.drawings = drawings.join('\n');
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  expect(output.sections.find(section => section.title === '实用新型内容')?.paragraphs).toEqual([...content, expect.stringMatching(/^综上所述，本实用新型的有益效果为：/u)]);
  expect(output.sections.find(section => section.title === '具体实施方式')?.paragraphs).toEqual(embodiment);
  expect(output.sections.find(section => section.title === '附图说明')?.paragraphs).toEqual(drawings);
  materials.drawings = materials.drawings.replace('图2', '图1');
  expect(() => sanitizeFinalPatentDocument(model.productTitle, model, materials)).toThrow('图号');
});

test('正式文档：只去除已知生成器说明行，保留创新点和运动关系', () => {
  const { model, materials } = fixture();
  materials.content = '创新点：快拆罩通过支架连接\n有益效果及依据：［待结合真实测试或使用情况核实，不代表授权结论］';
  materials.embodiment = '具体实施方式（结构模型驱动初稿，需人工核对）：\n工作原理：快拆罩连接支架并提供防护。\n运动关系：快拆罩的安装位置固定。';
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  expect(output.sections.find(section => section.title === '实用新型内容')?.paragraphs).toEqual(['创新点：快拆罩通过支架连接', expect.stringMatching(/^综上所述，本实用新型的有益效果为：/u)]);
  expect(output.sections.find(section => section.title === '具体实施方式')?.paragraphs).toEqual(['工作原理：快拆罩连接支架并提供防护。', '运动关系：快拆罩的安装位置固定。']);
});

test('正式文档：不完整的有益效果标题不能阻止规范结论写入 Word 正文', () => {
  const { model, materials } = fixture();
  materials.content = '技术方案：壳体连接支架。\n有益效果：便于拆装。';
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  const content = output.sections.find(section => section.title === '实用新型内容')?.paragraphs || [];
  expect(content).toContain('有益效果：便于拆装。');
  expect(content).toContainEqual(expect.stringMatching(/^综上所述，本实用新型的有益效果为：/u));
});

test('图号：统一 FIG 标识、SVG 图号、Word 图号及附图说明，拒绝冲突模型编号', async ({ page }) => {
  const { model, materials } = fixture();
  const output = sanitizeFinalPatentDocument(model.productTitle, model, materials);
  await mockStructure(page);
  await openNamedWorkspace(page);
  await generateStructure(page);
  for (const [index, figure] of PATENT_FIGURES.entries()) {
    await page.getByRole('tab', { name: figure.name }).click();
    const svg = await page.locator('.uw-svg').evaluate(element => element.outerHTML);
    expect(figure).toMatchObject({ id: `FIG-0${index + 1}`, figureIndex: index + 1, figureLabel: `图${index + 1}` });
    expect(svg).toContain(`data-figure-id="${figure.id}"`);
    expect(svg).toContain(`data-figure-label="${figure.figureLabel}"`);
    expect(svg).not.toContain('A（图3）');
    expect(FIGURE_LABELS[figure.kind]).toBe(output.figures[index].figureLabel);
    expect(FIGURE_DESCRIPTIONS[figure.kind]).toContain(figure.figureLabel);
    expect(output.sections.find(section => section.title === '附图说明')?.paragraphs[index]).toMatch(new RegExp(`^${figure.figureLabel}为`));
  }
  model.figureSpecs[0].id = 'F03';
  expect(() => sanitizeFinalPatentDocument(model.productTitle, model, materials)).toThrow('FIG-01必须对应F01');
});
