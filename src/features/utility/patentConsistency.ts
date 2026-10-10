import type { PatentStructureModel } from './patentStructure.ts';
import { getModelVersion } from './patentStructure.ts';
import type { ContentDesign } from './contentDrawing.ts';
import { actualFigureMarkers } from './figureConsistency.ts';

export type ConsistencyIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  componentIds?: string[];
  connectionIds?: string[];
  claimNo?: number;
};

export type PatentClaimReference = { claimNo: number; parentClaimNo?: number; componentIds: string[]; connectionIds: string[] };

export type PatentConsistencyInput = {
  model: PatentStructureModel;
  claimReferences?: PatentClaimReference[];
  claimsText?: string;
  text?: string;
  figureComponentIds?: string[][];
  design?: ContentDesign;
  documentSourceModelVersion?: string;
  drawingSourceModelVersion?: string;
  consistencySourceModelVersion?: string;
};

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function componentMentions(text: string) {
  return [...text.matchAll(/([\p{Script=Han}\w]+)[（(](C\d{2,3}|\d{1,3})[）)]/gu)].map(match => ({ label: match[1], token: match[2] }));
}

export function claimFeatureText(text: string): string {
  return text
    .replace(/^\s*\d+[.、．]\s*/u, '')
    .replace(/^根据权利要求\s*\d+\s*所述的[^，,\n]*[，,]\s*其特征在于[:：]/u, '')
    .replace(/^一种[^，,]+[，,]\s*/u, '');
}

export function claimComponentIds(text: string, model: PatentStructureModel): string[] {
  const body = claimFeatureText(text);
  const ids = new Set(body.match(/\bC\d{2,3}\b/gu) || []);
  const referenceMap = new Map(model.components.map((component, index) =>
    [component.referenceNo || String(Number(component.id.slice(1)) || index + 1), component.id]));
  for (const mention of componentMentions(body)) {
    const id = mention.token.startsWith('C') ? mention.token : referenceMap.get(mention.token);
    if (id) ids.add(id);
  }
  for (const component of model.components) if (body.includes(component.name)) ids.add(component.id);
  return [...ids];
}

export function validatePatentConsistency(input: PatentConsistencyInput): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const componentIds = new Set(input.model.components.map(component => component.id));
  const connectionIds = new Set(input.model.connections.map(connection => connection.id));
  const motionIds = new Set(input.model.motions.map(motion => motion.id));
  const innovationIds = input.model.components.filter(component => component.kind === 'innovation').map(component => component.id);
  const referenceMap = new Map(input.model.components.map((component, index) => [component.referenceNo || String(Number(component.id.slice(1)) || index + 1), component.id]));
  const resolveToken = (token: string) => token.startsWith('C') ? (componentIds.has(token) ? token : undefined) : referenceMap.get(token);
  const referencedText = input.text ?? input.claimsText ?? '';
  const modelVersion = getModelVersion(input.model);

  const drawingVersion = input.design?.sourceModelVersion || input.drawingSourceModelVersion;
  const stale = [
    ['文案', input.documentSourceModelVersion],
    ['附图', drawingVersion],
  ].filter((entry): entry is [string, string] => !!entry[1] && entry[1] !== modelVersion);
  const differentArtifacts = !!input.documentSourceModelVersion &&
    [input.drawingSourceModelVersion, input.design?.sourceModelVersion].some(version => version && version !== input.documentSourceModelVersion);
  if (stale.length || differentArtifacts) issues.push({
    code: differentArtifacts ? 'DOCUMENT_DRAWING_VERSION_MISMATCH' : 'SOURCE_MODEL_VERSION_MISMATCH', severity: 'error',
    message: `${differentArtifacts ? '文案与附图不是来自同一 PatentStructureModel 版本。' : ''}${stale.length ? `${stale.map(([label]) => label).join('和')}不是当前模型版本；请${stale.map(([label]) => `重新生成${label}`).join('、')}。` : '请重新生成附图。'}`,
  });
  if (input.drawingSourceModelVersion && input.design?.sourceModelVersion && input.drawingSourceModelVersion !== input.design.sourceModelVersion) {
    issues.push({ code: 'DRAWING_SOURCE_MODEL_MISMATCH', severity: 'error', message: '附图记录与实际附图的来源模型版本不一致。' });
  }
  if (input.design && !input.design.sourceModelVersion) issues.push({ code: 'DRAWING_VERSION_MISSING', severity: 'error', message: '附图缺少来源模型版本。' });
  if (input.claimsText !== undefined && !input.documentSourceModelVersion) issues.push({ code: 'DOCUMENT_VERSION_MISSING', severity: 'error', message: '文案缺少来源模型版本。' });

  // Stale artifacts must be regenerated before their content can be compared
  // with the new model; their old names and geometry are not independent defects.
  if (issues.some(issue => issue.severity === 'error')) return issues;

  for (const claim of input.claimReferences || []) {
    if ((claim.claimNo === 1 && claim.parentClaimNo !== undefined) || (claim.claimNo > 1 && claim.parentClaimNo !== undefined &&
      (claim.parentClaimNo >= claim.claimNo || !input.claimReferences?.some(parent => parent.claimNo === claim.parentClaimNo)))) {
      issues.push({ code: 'CLAIM_PARENT_INVALID', severity: 'error', message: `权利要求 ${claim.claimNo} 的上位引用无效，必须引用编号更小且已存在的权利要求。`, claimNo: claim.claimNo });
    }
    const missingComponents = claim.componentIds.filter(id => !componentIds.has(id));
    const missingConnections = claim.connectionIds.filter(id => !connectionIds.has(id));
    if (missingComponents.length) issues.push({ code: 'CLAIM_COMPONENT_MISSING', severity: 'error', message: `权利要求 ${claim.claimNo} 引用了结构模型不存在的部件。`, componentIds: missingComponents, claimNo: claim.claimNo });
    if (missingConnections.length) issues.push({ code: 'CLAIM_CONNECTION_MISSING', severity: 'error', message: `权利要求 ${claim.claimNo} 引用了结构模型不存在的连接关系。`, connectionIds: missingConnections, claimNo: claim.claimNo });
  }
  if (input.claimsText) {
    for (const match of input.claimsText.matchAll(/(?:^|\n)(\d+)\.\s*根据权利要求\s*(\d+)\s*所述/gu)) {
      const claimNo = Number(match[1]);
      const parentClaimNo = Number(match[2]);
      if (parentClaimNo >= claimNo || parentClaimNo < 1) issues.push({ code: 'CLAIM_PARENT_INVALID', severity: 'error', message: `权利要求 ${claimNo} 的正文引用了无效的上位权利要求。`, claimNo });
      const reference = input.claimReferences?.find(item => item.claimNo === claimNo);
      if (reference?.parentClaimNo !== undefined && reference.parentClaimNo !== parentClaimNo) issues.push({ code: 'CLAIM_PARENT_MISMATCH', severity: 'error', message: `权利要求 ${claimNo} 的正文引用与生成记录不一致。`, claimNo });
    }
    const claimedIds = new Set(input.claimsText.split('\n').flatMap(text => claimComponentIds(text, input.model)));
    const referencedIds = new Set((input.claimReferences || []).flatMap(claim => claim.componentIds));
    const unreferenced = [...claimedIds].filter(id => componentIds.has(id) && !referencedIds.has(id));
    if (unreferenced.length) issues.push({ code: 'CLAIM_REFERENCE_MISSING', severity: 'error', message: `权利要求中的部件缺少模型引用：${unreferenced.join('、')}。`, componentIds: unreferenced });
    const absent = innovationIds.filter(id => !claimedIds.has(id));
    if (absent.length) issues.push({ code: 'INNOVATION_NOT_IN_CLAIM_TEXT', severity: 'error', message: '核心创新部件未出现在权利要求正文中。', componentIds: absent });
  }

  if (referencedText) {
    const textComponentIds = [...new Set(referencedText.match(/\bC\d{2,3}\b/gu) || [])];
    const missingTextIds = textComponentIds.filter(id => !componentIds.has(id));
    if (missingTextIds.length) issues.push({ code: 'TEXT_COMPONENT_ID_MISSING', severity: 'error', message: `文案出现了结构模型不存在的部件编号：${missingTextIds.join('、')}。`, componentIds: missingTextIds });
    const mentions = componentMentions(referencedText);
    for (const { label, token } of mentions) {
      const id = resolveToken(token);
      const component = id ? input.model.components.find(item => item.id === id) : undefined;
      if (!id) {
        issues.push({ code: 'TEXT_COMPONENT_REFERENCE_MISSING', severity: 'error', message: `文案中“${label}（${token}）”的附图标号在结构模型中不存在。` });
        continue;
      }
      const named = input.model.components.filter(item => label.endsWith(item.name)).sort((a, b) => b.name.length - a.name.length)[0];
      if (component && (!named || named.id !== id)) {
        issues.push({ code: 'TEXT_COMPONENT_NAME_MISMATCH', severity: 'error', message: `${token} 在模型中为“${component.name}”，文案却称为“${named?.name || label}”。`, componentIds: [id] });
      }
    }
    const textConnectionIds = [...new Set(referencedText.match(/\bR\d{2,3}\b/gu) || [])];
    const missingTextConnections = textConnectionIds.filter(id => !connectionIds.has(id));
    if (missingTextConnections.length) issues.push({ code: 'TEXT_CONNECTION_ID_MISSING', severity: 'error', message: `文案出现了结构模型不存在的连接编号：${missingTextConnections.join('、')}。`, connectionIds: missingTextConnections });
    const textMotionIds = [...new Set(referencedText.match(/\bM\d{2,3}\b/gu) || [])];
    const missingTextMotions = textMotionIds.filter(id => !motionIds.has(id));
    if (missingTextMotions.length) issues.push({ code: 'TEXT_MOTION_ID_MISSING', severity: 'error', message: `文案出现了结构模型不存在的运动编号：${missingTextMotions.join('、')}。` });
    const relationWords: Record<string, string> = { '连接': 'connected_to', '固定连接': 'fixed_to', '滑动连接': 'slidably_connected', '转动连接': 'rotatably_connected', '驱动': 'driven_by', '支撑': 'supported_by', '限位': 'limited_by' };
    // 生成器产出的是“所述壳体（1）与所述支架（2）固定连接”，编号在括号里、名称在前；
    // 人工撰写的文案也可能是“C01（壳体）与所述C02（支架）固定连接”。两种形态都要能解析，
    // 因此先按名称或编号定位两端，再比对连接方式，而不是要求编号紧贴“与所述”。
    const componentByToken = new Map<string, string>();
    const componentByName = new Map<string, string>();
    for (const component of input.model.components) {
      componentByToken.set(component.referenceNo || String(Number(component.id.slice(1))), component.id);
      componentByToken.set(component.id, component.id);
      componentByName.set(component.name, component.id);
    }
    const resolveEndpoint = (token: string): string | undefined => {
      if (!token) return undefined;
      const normalized = token.normalize('NFKC').replace(/\s/gu, '');
      if (componentByToken.has(token)) return componentByToken.get(token);
      if (componentByName.has(normalized)) return componentByName.get(normalized);
      const byName = input.model.components.filter(item => normalized.endsWith(item.name)).sort((a, b) => b.name.length - a.name.length)[0];
      return byName?.id;
    };
    // 端点形如：C01（壳体）、壳体（1）、所述壳体（1）；关系词为动词。用具名捕获组，
    // 避免手工数括号时把关系词对错位（这正是旧的紧贴式正则漏检的原因）。
    const endpoint = (side: string) => `(?:(?<${side}Id>C\\d{2,3})\\s*[（(]\\s*(?<${side}Name>[^（）()]{1,40}?)\\s*[）)]|(?<${side}Name2>[^（(。；，、]{1,40}?)\\s*[（(]\\s*(?<${side}Token>C\\d{2,3}|\\d{1,3})\\s*[）)])`;
    const connectionPattern = new RegExp(`${endpoint('from')}\\s*(?:与|由)\\s*(?:所述)?${endpoint('to')}\\s*(?<verb>固定连接|滑动连接|转动连接|连接|驱动|支撑|限位)`, 'gu');
    for (const match of referencedText.matchAll(connectionPattern)) {
      const group = (match.groups || {}) as Record<string, string | undefined>;
      const from = resolveEndpoint(group.fromId || group.fromName || group.fromName2 || '') ?? resolveEndpoint(group.fromToken || '');
      const to = resolveEndpoint(group.toId || group.toName || group.toName2 || '') ?? resolveEndpoint(group.toToken || '');
      if (!from || !to) continue;
      const verb = group.verb!;
      if (!input.model.connections.some(connection => connection.from === from && connection.to === to && connection.relation === relationWords[verb])) {
        issues.push({ code: 'TEXT_CONNECTION_UNMODELED', severity: 'error', message: `文案中的“${from}”与“${to}”的${verb}关系不在结构模型中。`, componentIds: [from, to] });
      }
    }
    for (const component of input.model.components) {
      const numbers = new RegExp(`${escaped(component.name)}\\s*(?:[（(](\\d{1,3})[）)]|(\\d{1,3})(?![\\p{Script=Han}\\w]))`, 'gu');
      for (const pair of referencedText.matchAll(numbers)) {
        const named = input.model.components.filter(item => referencedText.slice(0, pair.index! + component.name.length).endsWith(item.name)).sort((a, b) => b.name.length - a.name.length)[0];
        if (named?.id !== component.id) continue;
        const number = pair[1] || pair[2];
        const expected = component.referenceNo || String(Number(component.id.slice(1)));
        if (number !== expected) {
          issues.push({ code: 'TEXT_COMPONENT_REFERENCE_MISMATCH', severity: 'error', message: `文案中“${component.name}${number}”的附图标号错误，应对应 ${expected}。`, componentIds: [component.id] });
        }
      }
    }
    for (const match of referencedText.matchAll(/C\d{2,3}[）)]执行([^，；。\n]+)/gu)) {
      const id = match[0].slice(0, match[0].indexOf('）') >= 0 ? match[0].indexOf('）') : match[0].indexOf(')'));
      if (!input.model.motions.some(motion => motion.componentId === id && motion.type === match[1])) {
        issues.push({ code: 'TEXT_MOTION_UNMODELED', severity: 'error', message: `${id} 的运动关系不在结构模型中。`, componentIds: [id] });
      }
    }
    for (const component of input.model.components) {
      if (referencedText.includes(component.name) && !(input.claimReferences || []).some(claim => claim.componentIds.includes(component.id))) {
        issues.push({ code: 'TEXT_COMPONENT_UNMAPPED', severity: 'warning', message: `文案提到了“${component.name}”，但尚未记录对应结构 ID ${component.id}。`, componentIds: [component.id] });
      }
    }
  }

  if (input.design) {
    let actual: string[][] = [];
    try { actual = actualFigureMarkers(input.design, input.model); }
    catch { issues.push({ code: 'DRAWING_MODEL_MISMATCH', severity: 'error', message: '附图几何与来源结构模型不一致。' }); }
    input.model.components.forEach(component => {
      const rendered = input.design!.components.find(part => part.componentId === component.id);
      if (!rendered || rendered.name.replace(/^\d+、/u, '') !== component.name ||
          JSON.stringify([rendered.shape, rendered.position, rendered.size, rendered.rotation]) !==
          JSON.stringify([component.geometry.shape, component.geometry.position, component.geometry.size, component.geometry.rotation])) {
        issues.push({ code: 'DRAWING_GEOMETRY_MISMATCH', severity: 'error', message: `${component.id} ${component.name} 的实际附图几何与结构模型不一致。`, componentIds: [component.id] });
      }
    });
    input.model.figureSpecs.forEach((spec, index) => {
      const marked = actual[index] || [];
      const missing = spec.componentIds.filter(id => !marked.includes(id));
      const unexpected = marked.filter(id => !spec.componentIds.includes(id));
      if (missing.length || unexpected.length) issues.push({ code: 'FIGURE_MARKERS_MISMATCH', severity: 'error', message: `${spec.id} 的实际附图标记与附图说明不一致：缺失 ${missing.join('、') || '无'}，未列出 ${unexpected.join('、') || '无'}。`, componentIds: [...missing, ...unexpected] });
      const unseenConnections = spec.connectionIds.filter(id => {
        const relation = input.model.connections.find(connection => connection.id === id);
        return relation && (!marked.includes(relation.from) || !marked.includes(relation.to));
      });
      if (unseenConnections.length) issues.push({ code: 'FIGURE_CONNECTION_ENDPOINT_MISSING', severity: 'error', message: `${spec.id} 中部分连接关系的部件未同时标注。`, connectionIds: unseenConnections });
    });
    if (input.model.connections.length) issues.push({ code: 'GEOMETRY_RELATIONS_REQUIRE_REVIEW', severity: 'warning', message: '附图为参数化黑白轮廓线稿，无法仅凭投影自动证明紧固、传动或限位关系；请人工核对连接方式及工程图。' });
    const drawnIds = input.design.components.map(part => part.componentId || '未绑定模型 ID');
    const unknownDrawn = drawnIds.filter(id => !componentIds.has(id));
    if (unknownDrawn.length) issues.push({ code: 'DRAWING_COMPONENT_MISSING', severity: 'error', message: `附图绘制了结构模型不存在的部件：${unknownDrawn.join('、')}。`, componentIds: unknownDrawn });
    if (new Set(drawnIds).size !== drawnIds.length || drawnIds.length !== input.model.components.length) {
      issues.push({ code: 'DRAWING_PART_COUNT_MISMATCH', severity: 'error', message: '实际附图的编号或部件数量与结构模型不一致。' });
    }
  }
  for (const ids of input.figureComponentIds || []) {
    const missing = ids.filter(id => !componentIds.has(id));
    if (missing.length) issues.push({ code: 'FIGURE_COMPONENT_MISSING', severity: 'error', message: '附图引用了结构模型不存在的部件。', componentIds: missing });
  }
  if (innovationIds.length && !(input.claimReferences || []).some(claim => innovationIds.some(id => claim.componentIds.includes(id)))) {
    issues.push({ code: 'INNOVATION_NOT_IN_CLAIMS', severity: 'warning', message: '核心创新部件尚未映射到任何权利要求。', componentIds: innovationIds });
  }
  if (innovationIds.length && !(input.figureComponentIds || []).some(ids => innovationIds.some(id => ids.includes(id)))) {
    issues.push({ code: 'INNOVATION_NOT_IN_FIGURES', severity: 'warning', message: '核心创新部件尚未出现在附图部件清单中。', componentIds: innovationIds });
  }
  return issues.filter((issue, index) => issues.findIndex(other => other.code === issue.code && other.message === issue.message) === index);
}

/**
 * 把一致性错误码映射为可操作的处理建议，让用户知道下一步该点哪里。
 */
export function consistencyIssueHint(code: string): string {
  if (code === 'SOURCE_MODEL_VERSION_MISMATCH' || code === 'DOCUMENT_DRAWING_VERSION_MISMATCH' || code === 'DOCUMENT_VERSION_MISSING') {
    return '版本已变化：请先点击「重新生成文案」，再导出 Word';
  }
  if (code.startsWith('CLAIM_') || code === 'INNOVATION_NOT_IN_CLAIM_TEXT') {
    return '请检查权利要求书的引用与部件编号，修正后重新生成文案再导出';
  }
  if (code.startsWith('TEXT_')) {
    return '文案与结构模型不一致：请修正文案中的部件编号/名称，或返回结构模型确认定义后重新生成文案';
  }
  if (code.startsWith('DRAWING_') || code.startsWith('FIGURE_')) {
    return '附图与结构模型不一致：请点击「重新生成附图」后再导出';
  }
  return '请根据提示修正后，重新生成对应内容再导出';
}

/**
 * 用户确认忽略的一致性错误豁免记录。豁免只绑定「问题 code + 文案原文 +
 * 模型版本」：文案或模型任一变化都会让豁免自动失效，避免把旧判断带到新版本。
 * 只有 error 级别的问题需要豁免，warning 本来就不阻断导出。
 */
export type ConsistencyExemption = {
  code: string;
  message: string;
  /** 用户填写的忽略原因，导出时不写入文件，仅随草稿保存备查。 */
  reason: string;
  modelVersion: string;
  exemptedAt: string;
};

export function isConsistencyExemption(value: unknown): value is ConsistencyExemption {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ConsistencyExemption>;
  return typeof item.code === 'string' && item.code.length > 0 &&
    typeof item.message === 'string' && item.message.length > 0 &&
    typeof item.reason === 'string' && item.reason.trim().length > 0 &&
    typeof item.modelVersion === 'string' && item.modelVersion.length > 0 &&
    typeof item.exemptedAt === 'string';
}

/**
 * 从问题列表中移除已被用户豁免的 error。豁免绑定模型版本：
 * 模型版本变化（重新生成结构）或问题文案变化（重新生成文案/附图）后，
 * 旧豁免自动失效，需要重新确认。
 */
export function applyConsistencyExemptions(issues: ConsistencyIssue[], exemptions: ConsistencyExemption[] | undefined, modelVersion: string): ConsistencyIssue[] {
  if (!exemptions?.length) return issues;
  const exempted = new Set(exemptions
    .filter(exemption => exemption.modelVersion === modelVersion)
    .map(exemption => `${exemption.code}\n${exemption.message}`));
  if (!exempted.size) return issues;
  return issues.filter(issue => issue.severity !== 'error' || !exempted.has(`${issue.code}\n${issue.message}`));
}
