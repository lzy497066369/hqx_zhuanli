import type { UtilityMaterials } from '../../data.ts';
import { PATENT_FIGURES } from './drawingModel.ts';
import type { PatentStructureModel } from './patentStructure.ts';
import { validateClaimDependencies } from './claimDependencies.ts';
import { getReferenceNo } from './patentStructure.ts';

type FormalSection = { title: string; paragraphs: string[] };
export type FinalPatentDocument = {
  title: string;
  abstract: string;
  claims: string[];
  sections: FormalSection[];
  figures: typeof PATENT_FIGURES;
};

const note = /^(?:拟议结构|待实物核对|待核对|待确认|待补充|需人工核对|标记为创新|示意(?:尺寸|位置|数量)(?:[与和/](?:尺寸|位置|数量))*)$/u;
const noteLabel = /^(?:AI分析|AI备注|内部分析|内部备注|验证备注|证据引用|Evidence|validation(?: notes)?|internal(?: metadata| notes)?|draft(?: notes)?)\s*[:：]/iu;
const evidence = /^(?:从而\s*)?(?:(?:依据|根据|参见)\s*)?E\d{2,3}(?:\s*[/、,，]\s*E\d{2,3})*\s*(?:明确|表明|说明|支持|显示|记载|可知|确认)/u;
const bareEvidence = /^E\d{2,3}(?:\s*[/、,，]\s*E\d{2,3})*$/u;
const brackets = /（[^（）]*）|\([^()]*\)|［[^［］]*］|\[[^[\]]*\]|【[^【】]*】/gu;
const punctuation = /[，,；;。\n]/u;
const end = (text: string) => text.replace(/[。；;]+$/u, '');

function fail(field: string): never {
  throw new Error(`正式文档清洗未通过：${field}含无法安全分离的内部备注或缺少有效正文，请核对该字段后再导出。`);
}

function isNote(text: string, rationale: boolean): boolean {
  const value = text.trim().replace(/[。；;]+$/u, '');
  if (note.test(value) || noteLabel.test(value) || evidence.test(value)) return true;
  if (rationale && bareEvidence.test(value)) return true;
  const pieces = value.split(/[，,；;\n]/u).map(item => item.trim()).filter(Boolean);
  return pieces.length > 1 && pieces.every(item => isNote(item, rationale));
}

// Read only explicit formal sources. Recognize whole annotation clauses, never
// remove keyword substrings from technical prose, names, part IDs or dimensions.
function formalText(source: string, field: string, required = false, rationale = false): string {
  let removed = false;
  const withoutNotes = source.replace(brackets, group => {
    if (!isNote(group.slice(1, -1), rationale)) return group;
    removed = true;
    return '';
  });
  const pieces: { text: string; separator: string }[] = [];
  let current = '', depth = 0;
  for (const character of withoutNotes) {
    if ('（(［[【'.includes(character)) depth++;
    if ('）)］]】'.includes(character)) depth--;
    if (!depth && punctuation.test(character)) {
      pieces.push({ text: current, separator: character }); current = '';
    } else current += character;
  }
  pieces.push({ text: current, separator: '' });
  const kept: typeof pieces = [];
  for (const piece of pieces) {
    const annotation = piece.text.trim().replace(/^(?:位置|设置理由|有益效果及依据)[:：]\s*/u, '');
    if (isNote(annotation, true)) {
      removed = true;
      const previous = kept.at(-1);
      if (previous && /[。\n]/u.test(piece.separator)) previous.separator = piece.separator;
    } else if (piece.text.trim()) kept.push({ ...piece });
  }
  let value = kept.map(piece => piece.text + piece.separator).join('').trim();
  if (removed) {
    value = value.replace(/[，,；;]+$/u, '');
    // A qualification attached to a numerical assertion cannot simply disappear.
    if (/待(?:实物)?核对/u.test(source) && /\d\s*(?:mm|cm|m\b|毫米|厘米|米|度|个|件|组|%)/iu.test(source)) fail(field);
  }
  const inspection = value.replace(brackets, '');
  if (/(?:拟议结构|待实物核对|示意(?:数量与位置|位置|尺寸))/u.test(inspection) ||
      /(?:^|[，,；;。\n：:])\s*(?:从而\s*)?(?:AI分析|AI备注|待核对|标记为创新|Evidence\s*[:：]|validation\s*[:：]|internal\s*[:：]|draft\s*[:：])/iu.test(inspection)) fail(field);
  if (required && !value) fail(field);
  return value;
}

// These are exact scaffolding lines emitted by makeUtilityMaterials. Any other
// material text, including additions not present in the model, remains authoritative.
const materialScaffolding = new Set([
  '具体实施方式（结构模型驱动初稿，需人工核对）：',
  '有益效果及依据：［待结合真实测试或使用情况核实，不代表授权结论］',
  '［模型未记录独立运动关系，需人工核对］',
]);

function materialParagraphs(source: string, field: string): string[] {
  return source.split(/\r?\n/u).flatMap(line => {
    if (materialScaffolding.has(line.trim())) return [];
    const text = formalText(line, field);
    return text ? [text] : [];
  });
}

export function sanitizeFinalPatentDocument(title: string, model: PatentStructureModel, materials: UtilityMaterials, patentType: 'utility' | 'invention' = 'utility', strict = false): FinalPatentDocument {
  const subject = patentType === 'invention' ? '本发明' : '本实用新型';
  const contentTitle = patentType === 'invention' ? '发明内容' : '实用新型内容';
  const identity = (value: string, field: string) => {
    const result = formalText(value, field, true);
    if (result !== value.trim()) fail(field);
    return result;
  };
  const formalTitle = identity(title, '专利名称');
  const parts = model.components.map((part, index) => ({
    id: part.id, referenceNo: getReferenceNo(part, index), kind: part.kind, name: identity(part.name, `${part.id}.name`),
    position: /^坐标\s/u.test(part.position) ? '' : formalText(part.position, `${part.id}.position`),
    purpose: formalText(part.purpose, `${part.id}.purpose`, true),
    reason: formalText(part.whyNeeded, `${part.id}.whyNeeded`, false, true),
  }));
  const component = (id: string) => {
    const part = parts.find(item => item.id === id);
    if (!part) throw new Error(`结构模型缺少部件 ${id}。`);
    return `${part.name}（${part.referenceNo}）`;
  };
  const connections = model.connections.map(link => {
    const verbs = { connected_to: '连接', fixed_to: '固定连接', slidably_connected: '滑动连接', rotatably_connected: '转动连接', driven_by: '驱动', supported_by: '支撑', limited_by: '限位' };
    const description = formalText(link.description, `${link.id}.description`);
    return `${component(link.from)}与${component(link.to)}${verbs[link.relation]}${description ? `，${end(description)}` : ''}。`;
  });
  const figures = PATENT_FIGURES.map(figure => {
    const source = model.figureSpecs.find(item => item.kind === figure.kind);
    if (!source || source.id !== figure.sourceId || (source.figureId && source.figureId !== figure.sourceId)) {
      throw new Error(`附图编号不一致：${figure.id}必须对应${figure.sourceId}（${figure.figureLabel}），请重新核对附图。`);
    }
    return { ...figure };
  });
  if (model.figureSpecs.length !== figures.length) throw new Error('附图数量不一致，无法导出 Word。');
  const drawings = figures.map(figure => `${figure.figureLabel}为${end(formalText(model.figureSpecs.find(item => item.kind === figure.kind)!.title, `${figure.id}.title`, true))}。`);
  drawings.push(`附图标记：${parts.map(part => `${part.referenceNo}、${part.name}`).join('；')}。`);
  const contentParagraphs = materialParagraphs(materials.content, contentTitle);
  const embodimentParagraphs = materialParagraphs(materials.embodiment, '具体实施方式');
  const drawingParagraphs = materialParagraphs(materials.drawings, '附图说明');
  if (strict) {
    if (!contentParagraphs.length) fail(contentTitle);
    if (!embodimentParagraphs.length) fail('具体实施方式');
    if (!drawingParagraphs.length) fail('附图说明');
  }
  if (drawingParagraphs.length) {
    const described = new Set<number>();
    for (const [index, paragraph] of drawingParagraphs.entries()) {
      const match = /^图\s*(\d+)\s*为\s*(.*)$/u.exec(paragraph);
      if (!match) continue;
      const figure = figures.find(item => item.figureIndex === Number(match[1]));
      if (!figure || described.has(figure.figureIndex)) throw new Error('附图说明图号缺失、重复或超出实际附图范围。');
      const title = model.figureSpecs.find(item => item.kind === figure.kind)!.title;
      const otherTitle = model.figureSpecs.find(item => item.kind !== figure.kind && match[2].startsWith(end(item.title)));
      if (otherTitle && !match[2].startsWith(end(title))) throw new Error(`${figure.figureLabel}的附图说明与实际图片不一致。`);
      described.add(figure.figureIndex);
      drawingParagraphs[index] = `${figure.figureLabel}为${match[2]}`;
    }
    if (described.size !== figures.length) throw new Error('附图说明必须完整包含图1、图2、图3。');
  }
  const claims = materials.claims.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((claim, index) => {
    const prefix = `${index + 1}. `;
    if (!claim.startsWith(prefix)) throw new Error('权利要求编号不连续，无法导出 Word。');
    const text = formalText(claim.slice(prefix.length), `权利要求${index + 1}`, true);
    const feature = text.split(/其特征在于[:：]/u).at(-1)!;
    if (!feature.trim() || /(?:设置于|位于|用于|从而|包括|连接于)\s*(?:[，。；]|$)/u.test(feature)) fail(`权利要求${index + 1}`);
    return prefix + text;
  });
  if (!claims.length) fail('权利要求书');
  const dependencyErrors = validateClaimDependencies(claims);
  if (dependencyErrors.length) fail(`权利要求书：${dependencyErrors.join('；')}`);
  const field = formalText(materials.technicalField, '技术领域', true);
  const base = formalText(model.baseStructure, '基础结构', true);
  const working = formalText(model.workingPrinciple, '工作原理', true);
  const solved = formalText(model.problemSolved, '解决的问题', true);
  const allParts = parts.map(part => component(part.id)).join('、');
  const reasons = parts.filter(part => part.reason && !/^需要/u.test(part.reason));
  const innovationReasons = reasons.filter(part => part.kind === 'innovation');
  const benefitSource = innovationReasons.length ? innovationReasons : reasons;
  const generatedBenefits = benefitSource.length
    ? benefitSource.map(part => `设置${component(part.id)}能够${end(part.reason)}`).join('；')
    : connections.length
      ? `通过${connections.map(text => end(text).replace(/。$/u, '')).join('，')}，使${end(working)}`
      : `通过各部件的配合，实现${end(working)}`;
  const benefitParagraph = `综上所述，${subject}的有益效果为：${generatedBenefits}。`;
  // These two exact legacy prefixes identify research scaffolding, not prior art.
  const researchScaffold = /^［(?:待补充已核实的现有技术|公开网页检索仅作撰写架构和表达方式参考)/u.test(materials.background);
  const background = researchScaffold
    ? `${formalTitle}涉及${end(field.replace(/^本(?:实用新型|发明)涉及/u, ''))}，其结构设计需要考虑${parts.map(part => part.name).join('、')}的配置及相互配合。`
    : formalText(materials.background, '背景技术', true);
  // Keep the formal conclusion stable even when the source uses a shorter
  // heading such as "有益效果：". Word output must contain the complete
  // conclusion sentence, so a partial mention cannot suppress this paragraph.
  const benefitPrefix = `综上所述，${subject}的有益效果为：`;
  const contentWithBenefits = strict ? contentParagraphs : contentParagraphs.length
    ? contentParagraphs.some(paragraph => paragraph.includes(benefitPrefix))
      ? contentParagraphs
      : [...contentParagraphs, benefitParagraph]
    : [];
  return {
    title: formalTitle, abstract: formalText(materials.abstract, '摘要', true), claims, figures,
    sections: [
      { title: '技术领域', paragraphs: field.split(/\r?\n/u).filter(Boolean).map(text => new RegExp(`^${subject}`).test(text) ? text : `${subject}涉及${end(text)}。`) },
      { title: '背景技术', paragraphs: background.split(/\r?\n/u).filter(Boolean) },
      { title: contentTitle, paragraphs: contentWithBenefits.length ? contentWithBenefits : [
        `${subject}的目的在于提供${formalTitle}，旨在实现${end(solved)}。`,
        `为实现上述目的，${formalTitle}包括${allParts}。${base}`,
        ...connections.map(text => `进一步地，${text}`),
        ...parts.filter(part => part.position).map(part => `进一步地，${component(part.id)}设置于${end(part.position)}。`),
        ...parts.map(part => `通过设置${component(part.id)}，其用于${end(part.purpose)}${!strict && reasons.includes(part) ? `，从而${end(part.reason)}` : ''}。`),
        ...(!strict ? [benefitParagraph] : []),
      ] },
      { title: '附图说明', paragraphs: drawingParagraphs.length ? drawingParagraphs : drawings },
      { title: '具体实施方式', paragraphs: embodimentParagraphs.length ? embodimentParagraphs : [
        `如${figures[0].figureLabel}至${figures.at(-1)!.figureLabel}所示，${formalTitle}包括${allParts}。`, base,
        ...parts.map(part => `${component(part.id)}${part.position ? `设置于${end(part.position)}，` : ''}用于${end(part.purpose)}。`),
        ...connections, `使用时，${working}`,
      ] },
    ],
  };
}
