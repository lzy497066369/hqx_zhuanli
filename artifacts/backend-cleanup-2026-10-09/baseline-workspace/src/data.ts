import { isNamingRecord } from "./features/utility/naming";
import type { NamingRecord } from "./features/utility/naming";
import { isModelParameters } from "./features/utility/drawingModel";
import type { ModelParameters } from "./features/utility/drawingModel";

import { isContentDesign } from "./features/utility/contentDrawing";
import { getModelVersion, getReferenceNo, isPatentStructureModel } from "./features/utility/patentStructure";
import type { ContentDesign } from "./features/utility/contentDrawing";
import type { ConfirmedStructureFact, InnovationNameCandidate, PatentStructureModel, ProductBrief } from "./features/utility/patentStructure";
import { isConfirmedStructureFacts } from "./features/utility/patentStructure";
import { isGeometryAlternatives, isGeometryRevision } from "./features/utility/structureEvidence";
import { isStructureDraft } from "./features/utility/structureDraft";
import type { StructureDraft, StructureStatus } from "./features/utility/structureDraft";
import { isEditableStructureSkeleton } from "./features/utility/structureSkeleton";
import type { StructureSkeleton } from "./features/utility/structureSkeleton";
import type { ConsistencyExemption, ConsistencyIssue, PatentClaimReference } from "./features/utility/patentConsistency";
import { isConsistencyExemption } from "./features/utility/patentConsistency";
import { selectParentClaim } from "./features/utility/claimDependencies";
import { isStructureEvidenceSelection } from "./features/utility/structureEvidence";
import { isEvidencePackage, validateEvidenceReferences } from "./features/utility/patentEvidence";
import type { EvidencePackage } from "./features/utility/patentEvidence";
import { freezePatentPackage } from './features/utility/patentPackage';
import type { StructureAssistanceResponse, StructureEvidenceSelection } from "./features/utility/structureEvidence";
import { isInventionFacts, isInventionMaterials, validateInventionMaterials } from './features/invention/invention';
import type { InventionFacts, InventionMaterials } from './features/invention/invention';

export const categories = [
  {
    id: "invention",
    name: "发明专利",
    en: "INVENTION PATENT",
    description: "让技术突破，成为专属的创新资产",
    tags: ["技术方案", "方法创新"],
    color: "green",
    hint: "描述技术背景、现有问题及核心创新点",
    sections: [
      "发明名称",
      "技术领域",
      "背景技术",
      "发明内容",
      "具体实施方式",
      "权利要求书",
      "摘要",
    ],
  },
  {
    id: "utility",
    name: "实用新型",
    en: "UTILITY MODEL",
    description: "聚焦产品结构，让实用创意落地",
    tags: ["产品结构", "实用改进"],
    color: "blue",
    hint: "描述产品结构、部件连接关系及改进点",
    sections: [
      "实用新型名称",
      "技术领域",
      "背景技术",
      "实用新型内容",
      "附图说明",
      "具体实施方式",
      "权利要求书",
    ],
  },
  {
    id: "design",
    name: "外观设计专利",
    en: "DESIGN PATENT",
    description: "留住独特美感，保护每一份设计",
    tags: ["产品外观", "视觉设计"],
    color: "purple",
    hint: "描述产品用途、造型特点、色彩及设计要点",
    sections: ["产品名称", "产品用途", "设计要点", "视图资料清单", "简要说明"],
  },
  {
    id: "software",
    name: "软件著作权",
    en: "SOFTWARE COPYRIGHT",
    description: "从一行代码，到属于你的数字资产",
    tags: ["软件程序", "文档编写"],
    color: "orange",
    hint: "描述软件功能、开发环境及主要技术特点",
    sections: [
      "软件名称及版本",
      "开发目的",
      "运行环境",
      "主要功能",
      "技术特点",
      "操作说明",
      "源代码资料清单",
    ],
  },
] as const;
export type CategoryId = (typeof categories)[number]["id"];
export type UtilityPart = {
  id: number;
  componentId?: string;
  referenceNo?: string;
  name: string;
};
export type UtilityDrawing = {
  version: 1;
  model?: ModelParameters; // Legacy reference settings: never used to draw new projects.
  geometryText?: string;
  design?: ContentDesign;
  technicalField: string;
  structure: string;
  workingPrinciple: string;
  parts: UtilityPart[];
  updatedAt: string;
  productBrief?: ProductBrief;
  innovationCandidates?: InnovationNameCandidate[];
  selectedInnovationCandidateId?: string;
  patentStructureModel?: PatentStructureModel;
  evidencePackage?: EvidencePackage;
  structureDraft?: StructureDraft;
  structureStatus?: StructureStatus;
  structureError?: string;
  pendingStructureEvidence?: StructureEvidenceSelection;
  pendingStructureFacts?: ConfirmedStructureFact[];
  pendingStructureSkeleton?: StructureSkeleton;
  structureAssistance?: StructureAssistanceResponse;
  consistencyReport?: ConsistencyIssue[];
  consistencySourceModelVersion?: string;
  /** 用户确认忽略的一致性错误豁免记录（绑定问题原文与模型版本）。 */
  consistencyExemptions?: ConsistencyExemption[];
};
export type UtilityMaterials = {
  version: 1;
  generationSource?: 'materials-v2';
  generationProof?: import('./features/utility/patentPackage').GenerationProof;
  generatedAt: string;
  abstract: string;
  claims: string;
  technicalField: string;
  background: string;
  content: string;
  drawings: string;
  embodiment: string;
  claimReferences?: PatentClaimReference[];
  consistencyReport?: ConsistencyIssue[];
  sourceModelVersion?: string;
};
export type Project = {
  id: string;
  name: string;
  category: CategoryId;
  description: string;
  owner: string;
  status: "draft" | "ready";
  updatedAt: string;
  demo?: boolean;
  naming?: NamingRecord;
  utilityDrawing?: UtilityDrawing;
  utilityMaterials?: UtilityMaterials;
  inventionFacts?: InventionFacts;
  inventionMaterials?: InventionMaterials;
};

const defaultUtilityPartTuples = [
  [1, "立柱"],
  [2, "固定板"],
  [3, "安装罩"],
  [4, "第一固定箱"],
  [5, "第二固定箱"],
  [6, "第一电机"],
  [7, "主齿轮"],
  [8, "从齿轮"],
  [9, "转动轴"],
  [10, "转盘"],
  [11, "连接杆"],
  [12, "扬声器"],
  [13, "第二电机"],
  [14, "安装轴"],
  [15, "转轮"],
  [16, "牵引绳"],
  [17, "挂环"],
  [18, "环形座"],
  [19, "第一滑块"],
  [20, "挂杆"],
  [21, "导轨"],
  [22, "第二滑块"],
] as const satisfies readonly [number, string][];

export const defaultUtilityParts: UtilityPart[] = defaultUtilityPartTuples.map(
  ([id, name]) => ({ id, name }),
);

function utilityProduct(project: Project) {
  return project.naming?.profile.product.trim() || project.name.replace(/^一种/, "");
}

export function defaultUtilityDrawing(project: Project): UtilityDrawing {
  const product = utilityProduct(project);
  const subject = project.category === 'invention' ? '本发明' : '本实用新型';
  return {
    version: 1,
    technicalField: `${subject}涉及${product}技术领域。［请核对技术领域］`,
    structure: project.naming?.profile.features.trim() || "",
    workingPrinciple: "",
    parts: [],
    geometryText: "",
    updatedAt: new Date().toISOString(),
  };
}

export function isUtilityDrawing(value: unknown): value is UtilityDrawing {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<UtilityDrawing>;
  return (
    item.version === 1 &&
    (item.model === undefined || isModelParameters(item.model)) &&
    (item.geometryText === undefined || typeof item.geometryText === "string") &&
    (item.design === undefined || isContentDesign(item.design)) &&
    (item.patentStructureModel === undefined || isPatentStructureModel(item.patentStructureModel)) &&
    (item.evidencePackage === undefined || (item.patentStructureModel !== undefined && isEvidencePackage(item.evidencePackage) && validateEvidenceReferences(item.patentStructureModel, item.evidencePackage).length === 0)) &&
    (item.structureDraft === undefined || isStructureDraft(item.structureDraft)) &&
    (item.structureStatus === undefined || ["DRAFT", "AI_GENERATING", "STRUCTURE_REVIEW", "STRUCTURE_CONFIRMED", "MODEL_COMPILED", "FAILED"].includes(item.structureStatus)) &&
    (item.structureError === undefined || typeof item.structureError === "string") &&
    (item.pendingStructureEvidence === undefined || isStructureEvidenceSelection(item.pendingStructureEvidence)) &&
    (item.pendingStructureFacts === undefined || isConfirmedStructureFacts(item.pendingStructureFacts)) &&
    (item.pendingStructureSkeleton === undefined || isEditableStructureSkeleton(item.pendingStructureSkeleton)) &&
    (item.structureAssistance === undefined || (typeof item.structureAssistance.summary === "string" &&
      ["needs_information", "unsupported"].includes(item.structureAssistance.status) &&
      Array.isArray(item.structureAssistance.questions) && item.structureAssistance.questions.every(question => typeof question === "string") &&
      (item.structureAssistance.geometryAlternatives === undefined || (item.structureAssistance.status === "unsupported" && isGeometryAlternatives(item.structureAssistance.geometryAlternatives))) &&
      (item.structureAssistance.geometryRevision === undefined || (item.structureAssistance.status === "unsupported" && isGeometryRevision(item.structureAssistance.geometryRevision))))) &&
    typeof item.technicalField === "string" &&
    typeof item.structure === "string" &&
    typeof item.workingPrinciple === "string" &&
    Array.isArray(item.parts) &&
    item.parts.length <= 30 &&
    item.parts.every(
      part =>
        !!part &&
        typeof part === "object" &&
        Number.isInteger((part as UtilityPart).id) && (part as UtilityPart).id > 0 && (part as UtilityPart).id <= 999 &&
        ((part as UtilityPart).referenceNo === undefined || /^\d{1,3}$/u.test((part as UtilityPart).referenceNo!)) &&
        typeof (part as UtilityPart).name === "string",
    ) &&
    (!item.design || (item.parts.length === item.design.components.length && item.parts.every((part, i) => part.id === item.design!.components[i].id && part.name === item.design!.components[i].name))) &&
    (item.consistencyExemptions === undefined || (Array.isArray(item.consistencyExemptions) && item.consistencyExemptions.every(isConsistencyExemption))) &&
    typeof item.updatedAt === "string"
  );
}



export function hasConfirmedUtilityStructure(project: Project, drawing = project.utilityDrawing): boolean {
  if (!drawing) return false;
  const model = drawing.patentStructureModel;
  return isPatentStructureModel(model) && model.productTitle === project.name;
}

export function makeUtilityMaterials(
  project: Project,
  drawing = project.utilityDrawing || defaultUtilityDrawing(project),
): UtilityMaterials {
  if (!hasConfirmedUtilityStructure(project, drawing) || !drawing.patentStructureModel) {
    const patentType = project.category === 'invention' ? '发明专利' : '实用新型';
    throw new Error(`请先确定与当前项目一致的 Patent Structure Model，才能生成${patentType}文案。`);
  }
  const model = drawing.patentStructureModel;
  const subject = project.category === 'invention' ? '本发明' : '本实用新型';
  const title = model.productTitle;
  const parts = model.components.map((component, index) => `${getReferenceNo(component, index)}、${component.name}`).join("；");
  const componentLabel = (id: string) => {
    const index = model.components.findIndex(item => item.id === id);
    const component = index >= 0 ? model.components[index] : undefined;
    return component ? `${component.name}（${getReferenceNo(component, index)}）` : '［未知部件］';
  };
  const relationClause = (connection: PatentStructureModel['connections'][number]) => {
    const from = `所述${componentLabel(connection.from)}`;
    const to = `所述${componentLabel(connection.to)}`;
    const relations: Record<typeof connection.relation, string> = {
      connected_to: `${from}与${to}连接`, fixed_to: `${from}与${to}固定连接`,
      slidably_connected: `${from}与${to}滑动连接`, rotatably_connected: `${from}与${to}转动连接`,
      driven_by: `${from}由${to}驱动`, supported_by: `${from}由${to}支撑`, limited_by: `${from}由${to}限位`,
    };
    return `${relations[connection.relation]}，${connection.description.replace(/[。；]+$/u, '')}`;
  };
  const modelParts = model.components.map(component => `${componentLabel(component.id)}：${component.purpose}；位置：${component.position}；设置理由：${component.whyNeeded}`).join("\n");
  const modelConnections = model.connections.map(relationClause).join("；\n");
  const claimBody = model.connections.map(connection => relationClause(connection).replace(/，.*$/u, '')).join('；');
  // A dependent claim can mention an additional component in its location
  // phrase (for example, "支架设置于壳体上"). Keep the claim mapping closed
  // over every model component named by that claim, not only its subject.
  const claimComponentIds = (text: string) => model.components
    .filter(component => text.includes(component.name))
    .map(component => component.id);
  const refs: PatentClaimReference[] = [{ claimNo: 1, componentIds: model.components.map(component => component.id), connectionIds: model.connections.map(connection => connection.id) }];
  const dependentClaims = [
    ...model.connections.map(connection => ({
      componentIds: [connection.from, connection.to], connectionIds: [connection.id],
      text: `${relationClause(connection)}。`,
    })),
    ...model.components.filter(component => component.position.trim() && !/^坐标\s/u.test(component.position)).map(component => ({
      componentIds: [component.id], connectionIds: [],
      text: `所述${componentLabel(component.id)}设置于${component.position.replace(/[。；]+$/u, '')}。`,
    })),
  ].slice(0, 7).map((item, index) => {
    const claimNo = index + 2;
    const componentIds = claimComponentIds(item.text);
    const parentClaimNo = selectParentClaim(claimNo, componentIds[0] || item.componentIds[0], refs);
    refs.push({ claimNo, parentClaimNo, componentIds, connectionIds: item.connectionIds });
    return `${claimNo}. 根据权利要求${parentClaimNo}所述的${title}，其特征在于：${item.text}`;
  });
  const detailId = model.figureSpecs.find(figure => figure.kind === 'detail')?.highlightComponentIds?.[0] || model.figureSpecs.find(figure => figure.kind === 'detail')?.componentIds[0] || '［待选择］';
  const detailIndex = model.components.findIndex(component => component.id === detailId);
  const detailComponent = detailIndex >= 0 ? model.components[detailIndex] : undefined;
  const detailName = detailComponent?.name || '［待选择部件］';
  return {
    version: 1,
    sourceModelVersion: getModelVersion(model),
    generatedAt: new Date().toISOString(),
    abstract: `${title}，包括${model.components.map(component => componentLabel(component.id)).join('、')}；${model.workingPrinciple}其结构旨在${model.problemSolved}。`,
    claims: [`1. ${title}，包括${model.components.map(component => componentLabel(component.id)).join('、')}，其特征在于：${claimBody}。`, ...dependentClaims].join('\n'),
    technicalField: model.technicalField,
    background: "［待补充已核实的现有技术、出处及实际存在的问题；不自动推断现有产品的缺陷］",
    content: project.category === 'invention'
      ? `${subject}所要解决的技术问题是：${model.problemSolved}\n为解决上述技术问题，${subject}采用的技术方案是：${model.baseStructure}\n${subject}的创新点包括：${model.innovationPoints.join("；")}\n\n部件及设置理由：\n${modelParts}\n\n连接关系：\n${modelConnections}\n\n有益效果及依据：［待结合真实测试或使用情况核实，不代表授权结论］`
      : `技术问题：${model.problemSolved}\n技术方案：${model.baseStructure}\n创新点：${model.innovationPoints.join("；")}\n\n部件及设置理由：\n${modelParts}\n\n连接关系：\n${modelConnections}\n\n有益效果及依据：［待结合真实测试或使用情况核实，不代表授权结论］`,
    drawings: `${model.figureSpecs.map(figure => `图${Number(figure.id.slice(1))}为${figure.title}，标注部件：${figure.componentIds.map(componentLabel).join('、')}`).join("\n")}\n局部放大目标：${detailName}（${detailComponent ? getReferenceNo(detailComponent, detailIndex) : detailId}）。\n附图标记：${parts}。`,
    embodiment: `具体实施方式（结构模型驱动初稿，需人工核对）：\n${modelParts}\n\n工作原理：${model.workingPrinciple}\n\n运动关系：\n${model.motions.map(motion => `${componentLabel(motion.componentId)}执行${motion.type}，${motion.path}；驱动部件：${motion.drivenBy ? componentLabel(motion.drivenBy) : '无'}；作用：${motion.purpose}`).join("\n") || "［模型未记录独立运动关系，需人工核对］"}\n\n附图与编号：${parts}`,
    claimReferences: refs,
    consistencyReport: drawing.consistencyReport,
  };
}

export function makeUtilityDocument(project: Project) {
  const materials = project.utilityMaterials;
  if (!materials || materials.generationSource !== 'materials-v2') throw new Error('请先生成并校验 V2 文案，暂不能导出');
  if (!project.utilityDrawing) throw new Error('请先确认结构并生成附图');

  const { document } = freezePatentPackage(project, project.utilityDrawing, materials);
  const patentType = project.category === 'invention' ? '发明专利' : '实用新型专利';
  return `${document.title}\n${patentType}申请材料整理初稿\n\n申请人：${project.owner || '待补充'}\n\n摘要\n${document.abstract}\n\n权利要求书\n${document.claims.join('\n')}\n\n${document.sections.map(section => `${section.title}\n${section.paragraphs.join('\n')}`).join('\n\n')}\n\n说明：本文件仅作为人工审核初稿，不代表正式专利申请文件或授权结论。`;
}
export const initialProjects: Project[] = [
  {
    id: "demo-1",
    name: "一种基于物联网的智能环境监测系统",
    category: "invention",
    description: "通过多传感器协同采集，实现环境数据的实时监测与异常提醒。",
    owner: "知创团队",
    status: "draft",
    updatedAt: "2026-09-22T01:30:00",
    demo: true,
  },
  {
    id: "demo-2",
    name: "知行协同办公管理平台 V1.0",
    category: "software",
    description: "面向团队的任务管理、文档协作和日程安排软件。",
    owner: "知创团队",
    status: "ready",
    updatedAt: "2026-09-21T15:20:00",
    demo: true,
  },
  {
    id: "demo-3",
    name: "一种可调节角度的便携式支架",
    category: "utility",
    description: "使用折叠结构与多段限位设计，支持多角度调节。",
    owner: "知创团队",
    status: "draft",
    updatedAt: "2026-09-20T09:15:00",
    demo: true,
  },
  {
    id: "demo-4",
    name: "桌面智能音箱外观设计",
    category: "design",
    description: "以圆角几何造型和织物表面构成简洁的桌面音箱外观。",
    owner: "知创团队",
    status: "ready",
    updatedAt: "2026-09-19T10:00:00",
    demo: true,
  },
];
export const STORAGE_KEY = "zhichuang-projects-v1";
/** Validate unknown data into projects; shared by the localStorage reader and the IndexedDB migration. */
export function sanitizeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return initialProjects;
  return value
    .filter(
      (p): p is Project =>
        !!p &&
        typeof p === "object" &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.description === "string" &&
        typeof p.owner === "string" &&
        categories.some((c) => c.id === p.category) &&
        ["draft", "ready"].includes(p.status) &&
        typeof p.updatedAt === "string" &&
        !Number.isNaN(Date.parse(p.updatedAt)),
    )
    .map((p) => ({
      ...p,
      naming: isNamingRecord(p.naming) ? p.naming : undefined,
      utilityDrawing: isUtilityDrawing(p.utilityDrawing)
        ? p.utilityDrawing
        : undefined,
      utilityMaterials:
        p.utilityMaterials &&
        typeof p.utilityMaterials === "object" &&
        (p.utilityMaterials as UtilityMaterials).version === 1 &&
        ["generatedAt", "abstract", "claims", "technicalField", "background", "content", "drawings", "embodiment"].every(key => typeof (p.utilityMaterials as unknown as Record<string, unknown>)[key] === "string")
          ? (p.utilityMaterials as UtilityMaterials)
          : undefined,
      inventionFacts: isInventionFacts(p.inventionFacts) ? p.inventionFacts : undefined,
      inventionMaterials: isInventionMaterials(p.inventionMaterials) ? p.inventionMaterials : undefined,
    }));
}
export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialProjects;
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return initialProjects;
  }
}
export function makeDocument(project: Project) {
  if (project.category === "utility") return makeUtilityDocument(project);
  if (project.category === 'invention' && project.inventionMaterials) {
    try {
      validateInventionMaterials(project.name, project.inventionFacts, project.inventionMaterials);
      const materials = project.inventionMaterials;
      return `${project.name}\n发明专利申请材料初稿\n\n说明书摘要\n${materials.abstract}\n\n权利要求书\n${materials.claims.join('\n')}\n\n说明书\n${materials.sections.map(section => `${section.title}\n${section.paragraphs.join('\n')}`).join('\n\n')}`;
    } catch { /* An edited title or facts invalidates the generated draft. */ }
  }
  const category = categories.find((c) => c.id === project.category)!;
  return `${project.name}\n${category.name} · 材料整理模板\n\n申请人 / 著作权人：${project.owner || "待补充"}\n\n项目描述\n${project.description || "待补充"}\n\n${category.sections.map((s, i) => `${i + 1}. ${s}\n[请补充相关内容]`).join("\n\n")}\n\n说明：这是前端演示的材料模板，未经 AI 生成或专业审核，不可直接作为正式申请文件。`;
}
