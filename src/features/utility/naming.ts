import { isStructureEvidenceOption, isStructureEvidenceSelection } from './structureEvidence.ts';
import type { StructureEvidenceOption, StructureEvidenceSelection } from './structureEvidence.ts';
import { isProblemProposal, isProblemSelection } from '../product/productProblems.ts';
import type { ProblemProposal, ProblemSelection } from '../product/productProblems.ts';

/** Naming input and response validation. No company lookup or novelty assessment. */
export type CompanyProfile = {
  company: string;
  business: string;
  product: string;
  features: string;
  excludedTerms: string;
  improvementType?: ImprovementType;
};
export type ImprovementType = 'shape' | 'structure' | 'combined';
export const improvementTypes: Record<ImprovementType, string> = {
  shape: '形状改进', structure: '构造改进', combined: '形状与构造结合',
};
export type Candidate = {
  name: string;
  product: string;
  feature: string;
  basis: string;
  inferred: boolean;
};
export type NamingRecord = {
  version: 1;
  profile: CompanyProfile;
  options?: { product: string; features: string[] }[];
  candidates: Candidate[];
  selectedName: string;
  confirmed: boolean;
  structureOptions?: StructureEvidenceOption[];
  structureSelection?: StructureEvidenceSelection;
  problemProposal?: ProblemProposal;
  problemSelection?: ProblemSelection;
  problemContext?: string;
};
export const emptyProfile: CompanyProfile = {
  company: "",
  business: "",
  product: "",
  features: "",
  excludedTerms: "",
  improvementType: undefined,
};
export const countCharacters = (text: string) => Array.from(text).length;
const promotional = [
  "高效",
  "节能",
  "最优",
  "万能",
  "新型",
  "神奇",
  "低阻力",
  "领先",
  "顶级",
  "超级",
  "最佳",
  "首创",
  "革命性",
];
const vague = ["及其他", "及其类似物", "等等", "某型号", "某工厂"];
const nonProduct = /方法|算法|流程|工艺|配方|用途|软件|程序|商业模式/;
const hardware =
  /装置|组件|设备|结构|机构|支架|接头|管路|风道|机械手|夹具|夹持器|壳体|箱体|机柜|连接件|连接器|传感器|机器人|逆变器|净水器|过滤器|输送机|工作台|模具|导轨|滑轨|叶片|齿轮|销钉|螺母|弹簧|铰链|阀|泵|柜|架|座|盒|板|管|机|系统|电路|容器|工具|灯|门|窗|车|床|桌|椅|杯|瓶|袋|罩|锁|环|轴|轮|盖|栓|塞|桶|槽|罐|器|件|梁|杆|框|片|盘|筒|带|网|布|柱|筋|页|块|砖|段|圈|膜|璃|骨|排|材|型|屏|镜|管件|法兰|轴套|垫片|密封件|隔板|栅格|格栅|梯|台|篦|辊|卷|丝|绳|链|齿条|蜗杆|丝杠|轴承|联轴器|离合|制动|减速|变速|泵体|缸|活塞|喷嘴|喷头|滤网|滤芯|膜片|衬板|面板|盖板|底座|支柱|横梁|纵梁|斜撑|拉杆|撑杆|立柱|栏杆|扶手|踏步|搁板|隔层|衬里|内衬/;
const genericProduct = /^(?:智能)?(?:产品|装置|设备|结构|组件|机构|系统|机器|材料|零件|部件|用品|工具|器件|支架|夹具|连接件)$/u;
const rawMaterial = /^(?:钢材|钢铁|金属|塑料|木材|板材|管材|布料|纺织品|原材料|建材|涂料|食品|化工品|橡胶|玻璃|纸张|石材)$/u;
const broadProduct = /^(?:钢结构|机械设备|电子设备|自动化设备|建筑结构|未识别到明确的产品客体)$/u;
const placeholder = /未识别到明确的产品客体|未识别|待确认|待补充|需用户提供|人工核对|模型分析|AI生成/u;
/** 配件／加工设备类尾词：名称以它们收尾时，保护的是产品之外的另一个东西。 */
const accessoryHeadNouns = ['连接组件', '连接件', '连接器', '安装支架', '紧固件', '螺栓', '卡扣', '配件', '附件', '夹具', '定位件', '加工设备', '生产设备', '生产线', '机床'];

/**
 * 名称的尾词是不是配件或加工设备。判定是相对的：用户产品本身就是安装支架时，
 * 名称以安装支架收尾是正确的，因此只在输入不是具体产品时才用它排除配件。
 */
export function isAccessorySubject(value: string): boolean {
  const text = value.trim().replace(/^一种/u, '');
  return accessoryHeadNouns.some(noun => text.endsWith(noun));
}

/** 用户名本身已是可辨认的具体产品（而非原材料、行业词或空泛客体）。 */
function isConcreteProduct(value: string): boolean {
  return !isMaterialOrCategory(value) && !checkProduct(value).length;
}
/**
 * 输入本身不是具体产品：原材料、带修饰的行业词（建筑钢材、钢结构）或空泛客体。
 * 这类输入允许被细化为具体产品（钢材→H型钢梁、建材→烧结多孔砖）。
 * 注意：这里只用于判断「输入侧」，不参与候选产品的合法性校验——
 * 铝合金型材、板材 等半成品仍是合法候选产品。
 */
const materialEnding = /(?:钢材|钢铁|合金|金属|塑料|橡胶|木材|石材|建材|原材料|原料|坯料|材料|布|纱|粉|膏|浆)$/u;
const shapePrefix = /^(?:H型|工字型?|槽型?|角型?|箱型?|C型|U型|L型|T型|Z型|圆|方|矩形|弧形|波纹|螺旋|锥形)/u;
const industryCategory = /^(?:五金|电子|机械|建筑|汽车|家具|日用品|包装|印刷|纺织|化工|医疗|食品|农业)(?:制品|产品|件)?$/u;
// These are finished textile products, not the raw-material category "布".
// Keep the explicit exception narrow so generic material terms remain rejected.
const finishedFabricProduct = /(?:无纺布|水刺布|熔喷布|针刺布|复合布)$/u;
export function isMaterialOrCategory(value: string): boolean {
  const text = value.trim().replace(/^一种/u, '');
  if (!text) return false;
  if (finishedFabricProduct.test(text)) return false;
  // 带形状修饰的材料词（H型建筑钢材、工字形钢材）已经是具体产品
  if (materialEnding.test(text) && shapePrefix.test(text)) return false;
  return rawMaterial.test(text) || broadProduct.test(text) || genericProduct.test(text) || materialEnding.test(text) || industryCategory.test(text);
}

/**
 * 候选产品是否仍属于用户所填的产品范围。
 * 输入是具体产品（H型钢梁）时，候选必须保留该产品本身，不能换成别的客体；
 * 输入是原材料或行业词（钢材、钢结构、建材）时，允许细化为任意具体产品，
 * 但不能细化为它的配件或加工设备（钢梁连接组件、钢梁定位夹具、机床）。
 */
export function keepsProtectedSubject(offered: string, business: string): boolean {
  const value = offered.trim().replace(/^一种/u, '');
  const subject = business.trim().replace(/^一种/u, '');
  if (!value || !subject) return false;
  if (!isConcreteProduct(subject)) return isConcreteProduct(value) && !isAccessorySubject(value);
  return value.includes(subject);
}

/**
 * 名称是否仍以用户填写的产品为主语。
 * 输入是具体产品（H型钢梁）时名称必须以该产品收尾；
 * 输入是原材料或行业词（钢材、钢结构）时允许细化为具体产品，
 * 但名称尾词不能是配件或加工设备。
 */
export function nameKeepsProductSubject(name: string, businesses: string[]): boolean {
  const value = name.trim().replace(/\s/gu, '');
  const subjects = businesses.map(item => item.trim().replace(/^一种/u, '')).filter(Boolean);
  if (!value || !subjects.length) return false;
  if (isAccessorySubject(value) && !subjects.some(isAccessorySubject)) return false;
  const concrete = subjects.filter(isConcreteProduct);
  // 已确认具体产品时必须以该产品收尾；输入只是材料或行业词时允许细化为具体产品。
  return concrete.length ? concrete.some(subject => value.endsWith(subject)) : true;
}
/** 客体是原材料、类目或空泛词时只提示，不阻断：用户应把它细化为保留该材料的实体产品。 */
export function checkProduct(product: string): string[] {
  const value = product.trim().replace(/^一种/u, "");
  if (!value || placeholder.test(value) || isMaterialOrCategory(value) || nonProduct.test(value) || !hardware.test(value))
    return ["请写明具体的实体产品，如H型钢梁、支架或连接组件。"];
  return [];
}
export function isStructuralFeature(feature: string): boolean {
  const value = feature.trim();
  return !!value && !placeholder.test(value) && !nonProduct.test(value) && !promotional.some(term => value.includes(term)) &&
    /型|形|截面|弧|孔|槽|齿|螺|卡|铰|轴|轨|梁|杆|框|板|片|层|纹|管|筒|轮|爪|臂|挡边|弹簧|密封|连接|固定|限位|支撑|定位|开合|折叠|排布|布置|结构|组件|机构|外壳|壳体/u.test(value) &&
    !/^(?:可拆卸|可调节|耐腐蚀|耐磨|稳定|轻便|灵活|高强度|高性能)$/u.test(value);
}
const splitTerms = (text: string) =>
  text
    .split(/[、，,；;\n]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
export function checkName(name: string, profile: CompanyProfile) {
  const errors: string[] = [],
    warnings: string[] = [];
  const length = countCharacters(name);
  const normalized = name.normalize("NFKC").replace(/\s/g, "");
  if (!name.trim()) errors.push("请输入名称。");
  if (length > 40) errors.push("超过本系统 40 字上限，请精简名称。");
  if (length > 25 && length <= 40)
    warnings.push(
      "超过一般 25 字要求，请优先精简；保留较长名称需要有技术上的必要性。",
    );
  if (length > 0 && length < 15)
    warnings.push("少于建议的 15 字；如已准确表达技术主题，不必为凑字数扩写。");
  if (/[。.．]/u.test(name)) errors.push("名称不能含句号。");
  if (/\s/u.test(name)) errors.push("请去除名称中的空格或换行。");
  const banned = [...promotional, ...vague].filter((term) =>
    normalized.includes(term),
  );
  if (banned.length)
    errors.push(`请移除宣传、效果或模糊词：${banned.join("、")}。`);
  const excluded = [
    profile.company.trim(),
    ...splitTerms(profile.excludedTerms),
  ].filter(Boolean);
  const found = excluded.filter((term) =>
    normalized
      .toLowerCase()
      .includes(term.normalize("NFKC").replace(/\s/g, "").toLowerCase()),
  );
  if (found.length)
    errors.push(`名称不应包含企业、品牌、人名或型号：${found.join("、")}。`);
  if (/(?:[a-z]+[-－]?\d+|\d+[-－]?[a-z]+|\d+型)/iu.test(normalized))
    warnings.push("包含疑似型号或代号，请人工确认是否为通用技术术语。");
  if (nonProduct.test(normalized))
    errors.push(
      "实用新型应以产品形状、构造或其结合为主题，请勿使用方法、算法或软件类名称。",
    );
  if (name && !hardware.test(normalized))
    errors.push("请写明具体的实体产品，如H型钢梁、支架或连接组件。");
  if (name && profile.business.trim() && !nameKeepsProductSubject(name, [profile.business, profile.product]))
    errors.push(
      `名称主体必须是所填产品「${profile.business.trim().replace(/^一种/u, "")}」本身，可加形状、结构或连接限定，但不能改成它的配件或加工设备。`,
    );
  if (
    /^(一种)?(智能)?(控制系统|监控系统|系统|装置|设备|结构|组件|机器人|产品)$/u.test(
      normalized,
    )
  )
    errors.push("名称过于笼统，请补充具体产品或结构限定。");
  if (/系统|智能|自适应/u.test(normalized))
    warnings.push(
      "请确认保护核心是具体硬件及连接关系，而非单纯控制逻辑或功能效果。",
    );
  if (name && !name.startsWith("一种"))
    warnings.push("建议按本系统模板以“一种”开头（不是法定强制前缀）。");
  return {
    length,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}
export function validateProfile(
  profile: CompanyProfile,
): Partial<Record<keyof CompanyProfile, string>> {
  const errors: Partial<Record<keyof CompanyProfile, string>> = {};
  if (!profile.company.trim()) errors.company = "请填写企业名称。";
  if (!profile.business.trim())
    errors.business = "请填写产品名称。";
  if (profile.company.length > 100)
    errors.company = "企业名称不能超过 100 字。";
  if (profile.business.length > 1000)
    errors.business = "产品名称不能超过 1000 字。";
  if (profile.product.length > 30) errors.product = "核心产品不能超过 30 字。";
  if (profile.features.length > 220)
    errors.features = "结构特征不能超过 220 字。";
  if (profile.excludedTerms.length > 200)
    errors.excludedTerms = "排除词不能超过 200 字。";
  if (profile.improvementType !== undefined && !Object.hasOwn(improvementTypes, profile.improvementType))
    errors.improvementType = "请选择有效的改进类型。";
  if (profile.product.trim()) {
    const check = checkName(`一种${profile.product.trim()}`, profile);
    const productErrors = [...check.errors, ...checkProduct(profile.product)];
    if (productErrors.length) errors.product = [...new Set(productErrors)].join(" ");
  }
  if (splitTerms(profile.features).length > 5)
    errors.features = "最多选择 5 个结构特征。";
  if (splitTerms(profile.features).some(feature => !isStructuralFeature(feature)))
    errors.features = "请选择具体的形状、部件或连接特征，不要只写功能或效果。";
  return errors;
}

export function isNamingRecord(value: unknown): value is NamingRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    typeof v.selectedName !== "string" ||
    typeof v.confirmed !== "boolean" ||
    !v.profile ||
    typeof v.profile !== "object" ||
    !Array.isArray(v.candidates)
  )
    return false;
  const p = v.profile as Record<string, unknown>;
  return (
    Object.keys(emptyProfile).every((k) => k === 'improvementType' ? p[k] === undefined || (typeof p[k] === 'string' && Object.hasOwn(improvementTypes, p[k])) : typeof p[k] === 'string') &&
    (v.options === undefined || (Array.isArray(v.options) && v.options.length <= 10 && v.options.every((option: { product?: unknown; features?: unknown }) => option && typeof option.product === 'string' && Array.isArray(option.features) && option.features.length <= 8 && option.features.every(feature => typeof feature === 'string')))) &&
    (v.structureOptions === undefined || (Array.isArray(v.structureOptions) && v.structureOptions.length <= 30 && v.structureOptions.every(isStructureEvidenceOption) && new Set(v.structureOptions.map(option => option.id)).size === v.structureOptions.length)) &&
    (v.structureSelection === undefined || isStructureEvidenceSelection(v.structureSelection)) &&
    (v.problemProposal === undefined || (isProblemProposal(v.problemProposal) && v.problemProposal.product === p.product)) &&
    (v.problemContext === undefined || (typeof v.problemContext === 'string' && v.problemContext.length <= 3000)) &&
    (v.problemSelection === undefined || (isProblemSelection(v.problemSelection) && v.problemSelection.product === p.product &&
      v.problemSelection.problem.suggestedName === v.selectedName && (!v.problemProposal || (
        (v.problemProposal as ProblemProposal).scenario === v.problemSelection.scenario &&
        (v.problemProposal as ProblemProposal).context === v.problemSelection.context &&
        (v.problemProposal as ProblemProposal).problems.some(item => JSON.stringify(item) === JSON.stringify(v.problemSelection && (v.problemSelection as ProblemSelection).problem)))))) &&
    v.candidates.length <= 9 &&
    v.candidates.every(
      (c) =>
        c &&
        typeof c === "object" &&
        ["name", "product", "feature", "basis"].every(
          (k) => typeof c[k] === "string",
        ) &&
        typeof c.inferred === "boolean",
    )
  );
}

export const utilityDraftKey = (id?: string) => id ? `zhichuang-utility-naming-v1:${id}` : "zhichuang-utility-naming-v1"
