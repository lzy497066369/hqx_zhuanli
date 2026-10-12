import type { AiConfig } from './aiSupport.ts';
import { AiFailure, aiProviders, attemptTimeoutMs as attemptTimeoutBudget } from './aiSupport.ts';
import { chatJson } from './patentStructureAi.ts';
import type { ProgressReporter } from './patentStructureAi.ts';
import { checkName, checkProduct, improvementTypes, isAccessorySubject, isStructuralFeature, keepsProtectedSubject, validateProfile } from '../src/features/utility/naming.ts';
import type { Candidate, CompanyProfile } from '../src/features/utility/naming.ts';
import { isStructureEvidenceSelection, missingStructureEvidenceCategories, selectedStructureEvidence } from '../src/features/utility/structureEvidence.ts';
import type { StructureEvidenceSelection } from '../src/features/utility/structureEvidence.ts';

export const NAMING_OPTIONS_PATH = '/api/utility/naming-options';
export const NAMING_NAMES_PATH = '/api/utility/naming-names';
const namingTimeoutMs = (config: AiConfig) => config.timeoutMs ?? 120000;

async function generateWithFallback(prompt: string, input: unknown, config: AiConfig, signal: AbortSignal, fetcher: typeof fetch, maxTokens: number, accept: (value: unknown) => boolean, onProgress?: ProgressReporter, stopOnInvalid = false) {
  const timeoutMs = namingTimeoutMs(config);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const attemptTimeoutMs = attemptTimeoutBudget(timeoutMs, 0.9, aiProviders(config).length);
  try {
    return await chatJson(prompt, input, config, combined, fetcher, maxTokens, undefined, value => {
      onProgress?.('筛选模型输出', '正在核对生成内容与已选产品结构');
      return accept(value);
    }, { attemptTimeoutMs, onProgress, stopOnInvalid });
  } catch (error) {
    if (signal.aborted) throw new AiFailure(499, 'AI_CANCELLED', '已取消本次生成。');
    if (timeout.aborted || (error instanceof AiFailure && error.code === 'AI_ATTEMPT_TIMEOUT')) throw new AiFailure(504, 'AI_TIMEOUT', '名称生成超时，请稍后重试。');
    throw error;
  }
}

type Option = { product: string; features: string[] };
const text = (value: unknown, max = 100) => typeof value === 'string' && !!value.trim() && value.length <= max;

export function isOptions(value: unknown): value is { options: Option[] } {
  const options = (value as { options?: unknown } | null)?.options;
  return Array.isArray(options) && options.length >= 3 && options.length <= 10;
}

const optionPrompt = `你是实用新型专利产品选题助手。只依据输入的产品名称，提出恰好五个供用户核对的实体产品方向。先判断输入是否已是可辨认的成品：如“光伏板”“无纺布”，每个 product 都必须以输入的完整产品名称结尾，仍保护该产品本身；可在前面加用途、类型、形状或结构限定，如“水刺无纺布”“带边框的光伏板”，不可改成光伏板边框连接件、无纺布生产设备等配件或设备。若输入是“钢材”等原材料、宽泛行业词，须细化为以该材料制成的具体实体产品本身，保留该材料词并给出形状或类别，如“H型钢梁”“槽钢柱”；绝不能细化为该产品的配件或加工设备（连接组件、安装支架、夹具、机床、生产线等），那些不是保护客体。不得宣称用户实际具备某结构。每个产品方向内部给出的结构特征应能够在一个完整产品中共存，不把互斥的固定/运动、密封/敞开等要求混成一组。不同方向之间可以有不同技术取舍。选项应彼此有实质差异，优先可辨认的形状、层状构造、部件安排与连接关系；材料或制造工艺可以限定产品类别，但不能单独当作实用新型的结构改进。每个 product 不超过30字，不带“一种”；给出2至5个对应产品自身可核对的简短结构特征（各不超过40字），用于后续核实，不把附属零件当成保护客体。无纺布等产品可描述可核对的层状、纹路或复合构造，不要仅以纤维材料或水刺工艺声称实用新型改进。不得编造尺寸、企业信息、可授权结论。只返回纯JSON：{"options":[{"product":"带网格压纹的无纺布","features":["网格压纹","双层叠置"]}, ...]}。`;
const namesPrompt = `你是实用新型名称助手。用户已确认保护客体 product、改进类型、结构资料和一至五项实际 features。生成5至6个不同的简洁产品名称，让人一眼看出保护的是产品本身，而不是部件清单或权利要求句子。每个名称以“一种”开头、以完整 product 结尾；通常完整包含一项已选 feature，选最能区分产品的一项即可，不必拼上所有特征。若 product 已比输入 productName 更具体，可有一个名称仅为“一种{product}”（如“一种水刺无纺布”），已确认的结构特征保留在技术资料中，不必全部写进标题。可以使用“带…的”“设有…的”等通顺连接词；不得写序号、标点、句号、“其…”“并…”等说明性分句，亦不得把产品改成其边框连接件等附件。形状改进体现外形、轮廓或截面，构造改进体现组成、连接或层状结构；材料和制造工艺本身不能替代形状或构造。不得添入未确认的结构、材料、功能、效果或新颖性主张。优先25字以内，最长40字，不含空格、品牌、人名、型号、宣传词，不重复 previous。返回纯JSON：{"names":["一种...","一种..."]}。`;
const namesRepairPrompt = `你是实用新型名称修复助手。product 和 features 均为已确认内容，不得改写。将草稿改成简洁产品名：以“一种”开头、以完整 product 结尾，通常完整包含至少一个已选 feature，优先只用一项；若 product 比 productName 更具体，可有一个名称只写“一种{product}”。不能写序号、标点、“其…”等说明句或擅自添加事实。优先25字以内，最多40字，不重复 previous 或 blockedNames。生成5至6个不同名称，至少3个合格。只返回纯JSON：{"names":["一种..."]}。`;

function keepsProductSubject(product: string, business: string) {
  return keepsProtectedSubject(product, business) && !isAccessorySubject(product);
}

function validOptions(value: unknown, profile: CompanyProfile, previous: string[]): Option[] {
  if (!isOptions(value)) return [];
  const seen = new Set(previous);
  return value.options.flatMap((option): Option[] => {
    if (!option || !text(option.product, 30) || seen.has(option.product) || !keepsProductSubject(option.product, profile.business) ||
        checkProduct(option.product).length ||
        checkName(`一种${option.product}`, profile).errors.length ||
        !Array.isArray(option.features) || option.features.length > 8) return [];
    const features = option.features.filter((feature: unknown): feature is string =>
      typeof feature === 'string' && text(feature, 40) && isStructuralFeature(feature) &&
      !checkName(`一种带${feature}的${option.product}`, profile).errors.length);
    const distinct = [...new Set(features)];
    if (distinct.length < 2) return [];
    seen.add(option.product);
    return [{ product: option.product, features: distinct.slice(0, 5) }];
  }).slice(0, 5);
}

function validNames(value: unknown, profile: CompanyProfile, features: string[], previous: string[]): string[] {
  const names = (value as { names?: unknown } | null)?.names;
  if (!Array.isArray(names) || names.length > 12) return [];
  const seen = new Set(previous);
  return names.filter((name): name is string => {
    if (typeof name !== 'string' || seen.has(name) || !name.startsWith('一种') ||
        /[、，,；;：:其]|并(?:开|设|有|且)/u.test(name) ||
        checkName(name, profile).errors.length || !name.endsWith(profile.product) ||
        !(features.some(feature => name.includes(feature)) ||
          (keepsProductSubject(profile.product, profile.business) && profile.product !== profile.business.trim() && name === `一种${profile.product}`))) return false;
    seen.add(name);
    return true;
  }).slice(0, 6);
}

function hasNameLengthCapacity(profile: CompanyProfile, features: string[]) {
  return features.some(feature => {
    const shortest = `一种${feature}${profile.product}`;
    return shortest.length <= 40 && !checkName(shortest, profile).errors.length;
  });
}

function localNameCandidates(profile: CompanyProfile, features: string[], previous: string[]) {
  const templates = [
    (feature: string) => `一种带${feature}的${profile.product}`,
    (feature: string) => `一种设有${feature}的${profile.product}`,
    (feature: string) => `一种具有${feature}的${profile.product}`,
    (feature: string) => `一种由${feature}构成的${profile.product}`,
    (feature: string) => `一种${feature}${profile.product}`,
  ];
  const names = validNames({ names: templates.flatMap(template => features.map(template)) }, profile, features, previous);
  return names.slice(0, 6);
}

export async function generateNamingOptions(body: unknown, config: AiConfig, signal: AbortSignal, fetcher: typeof fetch = fetch, onProgress?: ProgressReporter) {
  onProgress?.('核对产品资料', '正在检查企业名称和产品范围');
  const input = body as { company?: unknown; business?: unknown; excludedTerms?: unknown; previous?: unknown } | null;
  if (!input || !text(input.company, 100) || !text(input.business, 1000) || (input.excludedTerms !== undefined && (typeof input.excludedTerms !== 'string' || input.excludedTerms.length > 200)) || (input.previous !== undefined && (!Array.isArray(input.previous) || input.previous.length > 20 || !input.previous.every(value => text(value, 30))))) {
    throw new AiFailure(400, 'INVALID_INPUT', '请填写有效的企业名称和产品名称。');
  }
  const previous = (input.previous || []) as string[];
  const profile = { company: input.company as string, business: input.business as string, product: '', features: '', excludedTerms: (input.excludedTerms || '') as string };
  let result;
  try {
    result = await generateWithFallback(optionPrompt, { company: input.company, productName: input.business, excludedTerms: profile.excludedTerms, previous }, config, signal, fetcher, 1800, value => validOptions(value, profile, previous).length >= 3, onProgress);
  } catch (error) {
    if (error instanceof AiFailure && error.code === 'AI_INVALID_OUTPUT') throw new AiFailure(502, 'AI_INVALID_OPTIONS', 'AI 建议的合格保护客体不足 3 个，请换一批。');
    throw error;
  }
  return { options: validOptions(result.value, profile, previous), providerModel: result.model };
}

export async function generateNamingNames(body: unknown, config: AiConfig, signal: AbortSignal, fetcher: typeof fetch = fetch, onProgress?: ProgressReporter) {
  onProgress?.('核对已选资料', '正在检查保护客体、改进类型与结构资料');
  const input = body as { profile?: CompanyProfile; structureEvidence?: StructureEvidenceSelection; previous?: unknown } | null;
  const profile = input?.profile;
  if (!profile || !text(profile.company, 100) || !text(profile.business, 1000) || !text(profile.product, 30) || !text(profile.features, 220) || (profile.improvementType !== undefined && !Object.hasOwn(improvementTypes, profile.improvementType)) || (input.structureEvidence !== undefined && (!isStructureEvidenceSelection(input.structureEvidence) || !input.structureEvidence.confirmed || missingStructureEvidenceCategories(input.structureEvidence).length > 0)) || !Array.isArray(input.previous) || input.previous.length > 30 || !input.previous.every(value => text(value, 40))) {
    throw new AiFailure(400, 'INVALID_INPUT', '请先确认保护客体与结构特征。');
  }
  const selectedFeatures = profile.features.split(/[、，,；;]/u).map(value => value.trim()).filter(Boolean);
  const previous = input.previous as string[];
  if (Object.keys(validateProfile(profile)).length || selectedFeatures.some(feature => !isStructuralFeature(feature))) throw new AiFailure(400, 'INVALID_INPUT', '请确认具体的实体保护客体与实际形状、部件或连接特征。');
  if (!selectedFeatures.length || selectedFeatures.length > 5 || selectedFeatures.some(value => !text(value, 40))) throw new AiFailure(400, 'INVALID_INPUT', '请至少选择一项结构特征。');
  if (!hasNameLengthCapacity(profile, selectedFeatures)) throw new AiFailure(400, 'AI_NAME_LENGTH', '当前保护客体或结构特征过长，按完整保留规则无法在40字内生成合格名称；已选内容未改变，请精简保护客体表述或减少结构限定。');
  let result;
  let localFallback = false;
  try {
    const nameInput = { productName: profile.business, product: profile.product, features: selectedFeatures, confirmedStructure: selectedStructureEvidence(input.structureEvidence), improvementType: profile.improvementType ? improvementTypes[profile.improvementType] : undefined, excludedTerms: profile.excludedTerms, company: profile.company, previous };
    result = await generateWithFallback(namesPrompt, nameInput, config, signal, fetcher, 1500, value => validNames(value, profile, selectedFeatures, previous).length >= 3, onProgress, true);
    if ('invalid' in result && result.invalid) {
      onProgress?.('修复名称结果', '首轮名称未满足完整客体和结构特征约束，正在自动修复');
      const draftNames = Array.isArray((result.value as { names?: unknown } | null)?.names) ? (result.value as { names: unknown[] }).names.filter((name): name is string => typeof name === 'string') : [];
      const blockedNames = [...new Set([...previous, ...draftNames])];
      try {
        result = await generateWithFallback(namesRepairPrompt, { ...nameInput, previous, blockedNames, previousDraft: draftNames }, config, signal, fetcher, 1500, value => validNames(value, profile, selectedFeatures, previous).length >= 3, onProgress);
      } catch (error) {
        if (!(error instanceof AiFailure) || error.code !== 'AI_INVALID_OUTPUT') throw error;
        localFallback = true;
      }
    }
  } catch (error) {
    if (error instanceof AiFailure && error.code === 'AI_INVALID_OUTPUT') localFallback = true;
    else throw error;
  }
  const aiNames = result ? validNames(result.value, profile, selectedFeatures, previous) : [];
  const names = aiNames.length >= 3
    ? aiNames.slice(0, 6)
    : [...aiNames, ...localNameCandidates(profile, selectedFeatures, [...previous, ...aiNames])].slice(0, 6);
  if (names.length < 3) {
    if (localFallback || result) throw new AiFailure(502, 'AI_INVALID_NAMES', 'AI 生成的合格名称不足 3 个，请换一批名称；已选保护客体和特征未改变。');
    throw new AiFailure(502, 'AI_INVALID_NAMES', 'AI 未生成足够的合格名称；已选保护客体和特征未改变。');
  }
  const candidates: Candidate[] = names.map(name => ({ name, product: profile.product, feature: profile.features, basis: '根据已选保护客体与结构特征生成', inferred: false }));
  return { candidates, providerModel: result?.model || aiProviders(config)[0].model };
}
