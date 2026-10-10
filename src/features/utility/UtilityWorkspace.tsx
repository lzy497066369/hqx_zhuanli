import { PatentResearchView } from './PatentResearchView';
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  FileDown,
  FileText,
  ImageDown,
  PenLine,
  Save,
} from "lucide-react";
import type { Project, UtilityDrawing, UtilityMaterials } from "../../data";
import {
  defaultUtilityDrawing,
  makeDocument,
  hasConfirmedUtilityStructure,
} from "../../data";
import "./workspace.css";
import { UtilityFigure } from "./UtilityFigure";
import { FIGURE_NAMES as figureNames, FIGURE_DESCRIPTIONS, PATENT_DRAWING_STYLE, SVG_FRAME } from "./drawingModel";
import type { Figure } from "./drawingModel";

import type { ContentDesign } from "./contentDrawing";
import { buildContentAssembly, CONTENT_MODEL_REVISION, drawingSource } from "./contentDrawing";
import { modelToComponents, structureToGeometryText, getModelVersion, createModelVersion } from './patentStructure';
import { confirmStructureEvidence } from './patentEvidence';
import type { InnovationNameCandidate, PatentStructureResponse, ProductBrief } from './patentStructure';
import { PatentStructureFlow } from './PatentStructureFlow';
import type { StructureDraft, StructureStatus } from './structureDraft';
import type { StructureSkeleton } from './structureSkeleton';
import { applyConsistencyExemptions, consistencyIssueHint, validatePatentConsistency } from './patentConsistency';
import type { ConsistencyExemption } from './patentConsistency';
import { createUtilityWordBlob, utilityWordFilename } from "./wordExport";
import { buildReasoningPackage } from './patentReasoning';
import { createPatentGenerationContext } from './claimPlan';
import { freezePatentPackage } from './patentPackage';

function safeFilename(name: string, suffix: string) {
  return `${name.replace(/[/\\:*?"<>|]/g, "-")}-${suffix}`;
}

export function generationInputFingerprint(drawing: UtilityDrawing): string {
  return JSON.stringify({ model: drawing.patentStructureModel, evidence: drawing.evidencePackage, design: drawing.design });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function textFields(materials: UtilityMaterials) {
  return [
    ["摘要", materials.abstract],
    ["权利要求书", materials.claims],
    ["一、技术领域", materials.technicalField],
    ["二、背景技术", materials.background],
    ["三、实用新型内容", materials.content],
    ["四、附图说明", materials.drawings],
    ["五、具体实施方式", materials.embodiment],
  ] as const;
}

export function UtilityWorkspace({
  project,
  onSave,
  onMaterialsGenerated,
  onBack,
  patentType = "utility",
}: {
  project: Project;
  onSave: (drawing: UtilityDrawing, title?: string) => void;
  onMaterialsGenerated: (projectId: string, projectName: string, fingerprint: string, modelVersion: string, materials: UtilityMaterials) => void;
  onBack: () => void;
  patentType?: "utility" | "invention";
}) {
  const isInvention = patentType === "invention";
  const [drawing, setDrawing] = useState<UtilityDrawing>(() => {
    const saved = project.utilityDrawing;
    if (!saved) return defaultUtilityDrawing(project);
    // Preserve written content from old projects, but never show the unrelated
    // reference assembly or carry its default part list into a new drawing.
    return saved.design ? saved : { ...saved, parts: [], model: undefined };
  });
  const drawingRef = useRef(drawing);
  const projectRef = useRef(project);
  projectRef.current = project;
  const generationRef = useRef<AbortController | null>(null);
  const [generating, setGenerating] = useState(false);
  useEffect(() => () => { generationRef.current?.abort(); }, []);
  useEffect(() => { drawingRef.current = drawing; }, [drawing]);
  const saveDraftState = (changes: Partial<UtilityDrawing>) => {
    const next = { ...drawingRef.current, ...changes };
    drawingRef.current = next;
    setDrawing(next);
    onSave(next, project.name);
  };
  const [figure, setFigure] = useState<Figure>("overall");
  const [tab, setTab] = useState<"drawings" | "materials">("drawings");
  const [notice, setNotice] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const drawingPanelRef = useRef<HTMLElement>(null);
  const activeTitle = project.name;
  const structureModel = hasConfirmedUtilityStructure(project, drawing) ? drawing.patentStructureModel : undefined;
  const structureDetermined = !!structureModel;
  const current = !!structureModel && drawing.design?.sourceModelVersion === getModelVersion(structureModel);
  const model = useMemo(() => structureModel && drawing.design?.structureModel ? buildContentAssembly(drawing.design) : null, [structureModel, drawing.design]);
  const materials = project.utilityMaterials?.generationSource === 'materials-v2' &&
    structureModel && project.utilityMaterials.sourceModelVersion === getModelVersion(structureModel)
    ? project.utilityMaterials : null;
  const consistencyIssues = useMemo(() => structureModel && materials ? validatePatentConsistency({
    model: structureModel,
    claimReferences: materials.claimReferences,
    claimsText: materials.claims,
    text: textFields(materials).map(([, content]) => content).join('\n'),
    figureComponentIds: structureModel.figureSpecs.map(figureSpec => figureSpec.componentIds),
    design: drawing.design,
    documentSourceModelVersion: materials.sourceModelVersion,
    drawingSourceModelVersion: drawing.design?.sourceModelVersion,
    consistencySourceModelVersion: drawing.consistencySourceModelVersion,
  }) : [], [materials, structureModel, drawing.design, drawing.consistencySourceModelVersion]);
  // 用户确认忽略的误报不阻断导出；豁免绑定模型版本，模型变化后自动失效。
  const consistencyModelVersion = structureModel ? getModelVersion(structureModel) : '';
  const blockingIssues = applyConsistencyExemptions(consistencyIssues, drawing.consistencyExemptions, consistencyModelVersion)
    .filter(issue => issue.severity === 'error');
  // 下载 Word 被禁用时的具体原因：disabled 按钮不触发 title 提示，必须用可见文字说明。
  const wordBlockReason = !structureDetermined
    ? '请先确定 Patent Structure Model，才能导出 Word。'
    : !materials
      ? '请先生成当前结构模型的 V2 文案并通过校验。'
    : !current
      ? '结构模型已更新，附图基于旧版本模型，请先重新生成附图。'
      : blockingIssues.length > 0
        ? `一致性校验未通过（${blockingIssues.length} 个错误），请先处理或豁免标红问题。`
        : undefined;
  const [exemptingIndex, setExemptingIndex] = useState<number | null>(null);
  const [exemptReason, setExemptReason] = useState('');
  const confirmExemption = (index: number) => {
    const issue = consistencyIssues[index];
    const reason = exemptReason.trim();
    if (!issue || issue.severity !== 'error' || !reason || !structureModel) return;
    const exemption: ConsistencyExemption = {
      code: issue.code, message: issue.message, reason,
      modelVersion: consistencyModelVersion, exemptedAt: new Date().toISOString(),
    };
    saveDraftState({ consistencyExemptions: [...(drawingRef.current.consistencyExemptions || []), exemption] });
    setExemptingIndex(null);
    setExemptReason('');
    setNotice('已记录该问题的忽略原因；文案或模型变化后需重新确认。');
  };
  const revokeExemption = (exemption: ConsistencyExemption) => {
    saveDraftState({
      consistencyExemptions: (drawingRef.current.consistencyExemptions || [])
        .filter(item => !(item.code === exemption.code && item.message === exemption.message && item.modelVersion === exemption.modelVersion)),
    });
    setNotice('已撤销该问题的忽略，恢复为阻断状态。');
  };

  const applyPatentStructure = (brief: ProductBrief, candidates: InnovationNameCandidate[], candidate: InnovationNameCandidate, response: PatentStructureResponse, draft: StructureDraft): boolean => {
    const generatedAt = response.generatedAt;
    const modelWithVersion = response.model.modelVersion ? response.model : { ...response.model, modelVersion: createModelVersion() };
    const confirmed = confirmStructureEvidence(modelWithVersion, brief, response.research);
    const model = confirmed.model;
    const components = modelToComponents(model);
    const next: UtilityDrawing = {
      ...drawingRef.current,
      productBrief: brief,
      innovationCandidates: candidates,
      selectedInnovationCandidateId: candidate.id,
      patentStructureModel: model, evidencePackage: confirmed.evidence, structureDraft: draft, structureStatus: 'MODEL_COMPILED', structureError: undefined,
      pendingStructureEvidence: undefined, pendingStructureFacts: undefined, pendingStructureSkeleton: undefined, structureAssistance: undefined,
      technicalField: model.technicalField,
      structure: model.baseStructure,
      workingPrinciple: model.workingPrinciple,
      geometryText: structureToGeometryText(model),
      updatedAt: generatedAt,
      // 结构模型已更新：旧的一致性报告与豁免记录不再适用于新版本。
      consistencyReport: undefined,
      consistencySourceModelVersion: undefined,
      consistencyExemptions: undefined,
    };
    // 结构模型已更新：附图必须按新模型重建，不能沿用旧版本的 design，否则附图版本永远过期。
    next.design = {
      revision: CONTENT_MODEL_REVISION,
      title: candidate.name,
      source: drawingSource(candidate.name, next),
      generatedAt,
      components,
      detailPartId: components.find(component => component.componentId === model.components.find(item => item.kind === 'innovation')?.id)?.id || components[0].id,
      detailComponentId: model.components.find(item => item.kind === 'innovation')?.id || components[0].componentId,
      sourceModelVersion: getModelVersion(model),
      structureModel: model,
      ...(response.providerModel === 'manual/offline' ? {} : { ai: { model: response.providerModel, source: response.source, generatedAt, summary: response.researchSummary, assumptions: [] } }),
    };
    next.parts = components.map(component => ({ id: component.id, componentId: component.componentId, referenceNo: component.referenceNo, name: component.name }));
    drawingRef.current = next;
    setDrawing(next);
    onSave(next, project.name);
    setNotice(`已确认“${candidate.name}”的统一 Patent Structure Model，并据此开放文案和附图；请核对后保存。`);
    return true;
  };

  const save = () => {
    // The PatentStructureModel chooses the innovation component as the
    // canonical figure-3 target. A temporary viewport selection may be used
    // while reviewing, but saving must not replace the model's authoritative
    // detail target with a neighbouring component.
    const persisted = { ...drawing, consistencyReport: consistencyIssues, consistencySourceModelVersion: structureModel ? getModelVersion(structureModel) : undefined };
    onSave(persisted, activeTitle);
    setDrawing(persisted);
    drawingRef.current = persisted;
  };
  const regenerateMaterials = async () => {
    if (!structureModel) { setNotice('请先确定 Patent Structure Model。'); return; }
    generationRef.current?.abort();
    const controller = new AbortController();
    generationRef.current = controller;
    const version = getModelVersion(structureModel);
    const projectName = project.name;
    const projectId = project.id;
    const fingerprint = generationInputFingerprint(drawingRef.current);
    setGenerating(true);
    setNotice('正在生成 V2 文案…');
    try {
      const evidence = drawingRef.current.evidencePackage;
      if (!evidence) throw new Error('缺少已确认的证据包，请重新确认结构');
      const reasoning = buildReasoningPackage(structureModel, evidence);
      const context = createPatentGenerationContext(structureModel, evidence, reasoning);
      const response = await fetch('/api/utility/materials-v2', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, patentType }), signal: controller.signal,
      });
      const started = await response.json();
      if (!response.ok || typeof started.taskId !== 'string') throw new Error(started.message || 'V2 文案生成未能启动');
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { window.clearTimeout(timer); reject(new Error('已取消生成')); };
          const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 1200);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const statusResponse = await fetch(`/api/utility/materials-v2/status/${encodeURIComponent(started.taskId)}`, { signal: controller.signal });
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.message || '查询 V2 任务失败');
        if (status.status === 'failed') throw new Error(status.error || '最终校验未通过，禁止使用旧模板替代');
        if (status.status === 'completed') {
          if (!status.result?.readyForExport || status.materials?.generationSource !== 'materials-v2' ||
              status.materials.sourceModelVersion !== version) throw new Error('V2 结果未通过最终校验');
          const latest = drawingRef.current;
          if (controller.signal.aborted || projectRef.current.id !== projectId || projectRef.current.name !== projectName ||
              !latest.patentStructureModel || getModelVersion(latest.patentStructureModel) !== version ||
              latest.design?.sourceModelVersion !== version || generationInputFingerprint(latest) !== fingerprint) {
            throw new Error('生成期间项目、证据、结构或附图已更新，请重新生成文案');
          }
          freezePatentPackage({ ...project, utilityDrawing: latest, utilityMaterials: status.materials }, latest, status.materials);
          onMaterialsGenerated(projectId, projectName, fingerprint, version, status.materials);
          setNotice('V2 文案已生成并通过最终校验。');
          return;
        }
        if (status.status !== 'running') throw new Error('V2 任务返回了未知状态');
        setNotice(status.message || '正在生成 V2 文案…');
      }
      throw new Error('V2 文案生成超时，请重试');
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'V2 文案生成失败');
    } finally {
      if (generationRef.current === controller) { generationRef.current = null; setGenerating(false); }
    }
  };
  const regenerateDrawing = () => {
    if (!structureModel) return;
    const components = modelToComponents(structureModel);
    const detailComponentId = structureModel.figureSpecs.find(spec => spec.kind === 'detail')?.highlightComponentIds?.[0] ||
      structureModel.components.find(component => component.kind === 'innovation')!.id;
    const design: ContentDesign = {
      revision: CONTENT_MODEL_REVISION, title: activeTitle, source: drawingSource(activeTitle, drawing), generatedAt: new Date().toISOString(),
      components, detailPartId: Number(detailComponentId.slice(1)), detailComponentId,
      sourceModelVersion: getModelVersion(structureModel), structureModel,
    };
    const next = { ...drawing, design, parts: components.map(({ id, componentId, referenceNo, name }) => ({ id, componentId, referenceNo, name })), consistencyReport: undefined, consistencySourceModelVersion: undefined, consistencyExemptions: undefined };
    drawingRef.current = next;
    setDrawing(next);
    onSave(next, activeTitle);
    setNotice(`已按 ${getModelVersion(structureModel)} 重新生成附图。`);
  };
  // 自愈：附图版本过期时自动重生成（处理历史遗留的过期附图；新确认模型已在 applyPatentStructure 中重建）。
  // 依赖版本比对而非空数组，保证 Vite HMR 更新后也会触发，无限循环由版本一致守卫阻断。
  useEffect(() => {
    if (!structureDetermined || !drawing.design) return;
    if (drawing.design.sourceModelVersion === getModelVersion(structureModel!)) return;
    regenerateDrawing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureDetermined, drawing.design?.sourceModelVersion, structureModel]);
  const revealDrawingStep = () => {
    requestAnimationFrame(() => drawingPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const exportText = () => { if (!structureDetermined || !materials) { setNotice('请先生成当前结构模型的 V2 文案。'); return; } if (blockingIssues.length) { setNotice(`一致性校验未通过：${blockingIssues.map(issue => `${issue.message}（${consistencyIssueHint(issue.code)}）`).join('；')}`); return; } try { freezePatentPackage({ ...project, utilityDrawing: drawing }, drawing, materials); downloadBlob(new Blob([makeDocument({ ...project, utilityDrawing: drawing, utilityMaterials: materials })], { type: "text/plain;charset=utf-8" }), safeFilename(activeTitle, "材料初稿.txt")); } catch (error) { setNotice(error instanceof Error ? error.message : '文案校验失败'); } };
  const exportWord = async () => {
    if (!structureDetermined || !materials || !current || !drawing.design || blockingIssues.length) {
      if (!structureDetermined) setNotice('请先确定 Patent Structure Model，暂不能生成专利文案。');
      else if (!materials) setNotice('请先重新生成文案，暂不能导出 Word。');
      else if (!current || !drawing.design) setNotice('结构模型已更新，附图基于旧版本模型，请先重新生成附图再导出 Word。');
      else if (blockingIssues.length) setNotice(`一致性校验未通过：${blockingIssues.map(issue => `${issue.message}（${consistencyIssueHint(issue.code)}）`).join('；')}`);
      return;
    }
    setNotice("正在生成 Word 文件，请稍候…");
    try {
      const blob = await createUtilityWordBlob({ ...project, utilityDrawing: drawing }, drawing, materials);
      downloadBlob(blob, utilityWordFilename(activeTitle, patentType));
      setNotice("Word 文件已生成，包含摘要、权利要求书、说明书和三张附图。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Word 文件生成失败，请重试。");
    }
  };
  const exportSvg = () => {
    if (!structureDetermined || blockingIssues.length) { setNotice('请先确定并通过 Patent Structure Model 一致性校验，暂不能生成附图。'); return; }
    const svg = canvasRef.current?.querySelector("svg");
    if (!svg || !current) return;
    downloadBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }), safeFilename(activeTitle, `${figureNames[figure].replaceAll(" · ", "-")}.svg`));
  };
  const exportPng = () => {
    if (!structureDetermined || blockingIssues.length) { setNotice('请先确定并通过 Patent Structure Model 一致性校验，暂不能生成附图。'); return; }
    const svg = canvasRef.current?.querySelector("svg");
    if (!svg || !current) return;
    const source = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.onload = () => {
      const latest = canvasRef.current?.querySelector("svg");
      if (!latest || new XMLSerializer().serializeToString(latest) !== source) {
        setNotice("绘图内容已修改，已取消旧图导出，请重新生成后导出。");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = SVG_FRAME.width * 2;
      canvas.height = SVG_FRAME.height * 2;
      const context = canvas.getContext("2d");
      if (!context) { setNotice("当前浏览器无法生成 PNG，请使用 SVG 导出。"); return; }
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, safeFilename(activeTitle, `${figureNames[figure].replaceAll(" · ", "-")}.png`));
        else setNotice("PNG 导出失败，请使用 SVG 导出。");
      }, "image/png");
    };
    image.onerror = () => setNotice("PNG 图像载入失败，请使用 SVG 导出。");
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  };

  return (
    <div className="utility-workspace">
      <div className="uw-topline">
        <button className="uw-back" onClick={onBack}><ArrowLeft size={16} /> 返回名称页</button>
        <div className="uw-actions">
          <span className="uw-status"><Check size={15} /> 编辑即时保存到此浏览器</span>
          <button className="button secondary" onClick={exportText} disabled={!structureDetermined || blockingIssues.length > 0} title={!structureDetermined ? "请先确定 Patent Structure Model" : undefined}><FileText size={16} /> 导出材料 TXT</button>
          <button className="button primary" onClick={save}><Save size={16} /> 保存工作区</button>
        </div>
      </div>
      <header className="uw-heading">
        <div>
          <div className="uw-eyebrow">UTILITY MODEL · DRAWING & MATERIALS</div>
          <h1>{activeTitle}</h1>
          <p>名称已确定。接下来确认结构模型，再分别生成附图和申请材料。</p>
        </div>
        <span className="uw-disclaimer">仅为材料整理初稿，不代表正式申请文件</span>
      </header>
      <ol className="uw-workflow" aria-label="实用新型创作步骤">
        <li className="done"><span>01</span><strong>确定名称</strong><small>已保存</small></li>
        <li aria-current={!structureDetermined ? 'step' : undefined} className={structureDetermined ? 'done' : ''}><span>02</span><strong>确认结构</strong><small>{structureDetermined ? '模型已编译' : '当前步骤'}</small></li>
        <li aria-current={structureDetermined && tab === 'drawings' ? 'step' : undefined}><span>03</span><strong>绘图与部件</strong><small>{structureDetermined ? '核对附图' : '等待模型'}</small></li>
        <li aria-current={structureDetermined && tab === 'materials' ? 'step' : undefined}><span>04</span><strong>申请材料</strong><small>{structureDetermined ? '核对文案' : '等待模型'}</small></li>
      </ol>
      <p className="uw-warning">公开专利仅供撰写架构参考。名称不能证明真实构造；结构草案须通过校验和离线编译，附图采用统一参数化黑白轮廓线稿，复杂自由曲面与工程可行性仍需专业审核。</p>
      <PatentStructureFlow key={`${project.id}:${project.name}`} project={project} drawing={drawing} onApply={applyPatentStructure} onComplete={revealDrawingStep}
        onEvidenceConfirmed={selection => saveDraftState({ pendingStructureEvidence: selection, structureAssistance: undefined, structureError: undefined })}
        onFactsConfirmed={facts => saveDraftState({ pendingStructureFacts: facts, structureError: undefined })}
        onSkeleton={ (skeleton: StructureSkeleton | undefined) => saveDraftState({ pendingStructureSkeleton: skeleton, structureAssistance: undefined, structureError: undefined }) }
        onAssistance={result => saveDraftState({ structureAssistance: result, structureStatus: 'FAILED', structureError: result.summary })}
        onStatus={(status: StructureStatus, error?: string) => {
          saveDraftState({ structureStatus: status, structureError: error });
        }} />
      {notice && <p role="alert">{notice}</p>}
      {structureDetermined && !current && <p role="status">结构模型已更新，当前文案和附图可能基于旧版本模型。请分别主动重新生成。</p>}
      {structureDetermined && consistencyIssues.length > 0 && <div className="uw-consistency-report" data-testid="consistency-report"><strong>一致性校验</strong><p className="uw-consistency-note">校验为启发式规则；确认为误报的错误可填写原因后忽略，不再阻断导出。文案或模型变化后需重新确认。</p><ul>{consistencyIssues.map((issue, index) => {
        const exemption = issue.severity === 'error'
          ? (drawing.consistencyExemptions || []).find(item => item.code === issue.code && item.message === issue.message && item.modelVersion === consistencyModelVersion)
          : undefined;
        return <li key={`${issue.code}-${index}`}>{issue.severity === 'error' ? '错误' : '提示'}：{issue.message}{issue.severity === 'error' ? `（${consistencyIssueHint(issue.code)}）` : ''}
          {issue.severity === 'error' && (exemption ? (
            <span className="uw-exempted">已忽略：{exemption.reason}<button type="button" className="uw-exempt-link" onClick={() => revokeExemption(exemption)}>撤销忽略</button></span>
          ) : exemptingIndex === index ? (
            <span className="uw-exempt-form"><textarea aria-label="忽略原因" rows={2} maxLength={200} placeholder="请填写确认忽略的原因（必填），例如：此处为现有技术描述，不指本方案部件" value={exemptReason} onChange={event => setExemptReason(event.target.value)} /><button type="button" className="button secondary" disabled={!exemptReason.trim()} onClick={() => confirmExemption(index)}>确认忽略</button><button type="button" className="uw-exempt-link" onClick={() => { setExemptingIndex(null); setExemptReason(''); }}>取消</button></span>
          ) : (
            <button type="button" className="uw-exempt-link" onClick={() => { setExemptingIndex(index); setExemptReason(''); }}>确认无误，忽略此问题</button>
          ))}
        </li>;
      })}</ul></div>}
      <div className="uw-tabs" role="tablist" aria-label="工作区视图">
        <button role="tab" aria-selected={tab === "drawings"} className={tab === "drawings" ? "active" : ""} onClick={() => setTab("drawings")}><PenLine size={17} /> 绘图与部件</button>
        <button role="tab" aria-selected={tab === "materials"} aria-disabled={!structureDetermined} disabled={!structureDetermined} title={!structureDetermined ? "确定 Patent Structure Model 后开放" : undefined} className={tab === "materials" ? "active" : ""} onClick={() => { if (structureDetermined) setTab("materials"); }}><FileText size={17} /> 申请材料</button>
      </div>
      {!structureDetermined && <section className="uw-structure-gate" role="status" aria-live="polite">
        <strong>Patent Structure Model 尚未确定</strong>
        <p>请先根据已确认名称自动生成结构模型。生成失败时可重新生成；模型未确定前不能生成附图与申请材料。</p>
      </section>}
      {tab === "drawings" ? (
        <div className="uw-layout">
          <section className="uw-panel uw-drawing-panel" aria-labelledby="drawing-heading" ref={drawingPanelRef}>
            <div className="uw-panel-heading"><div><h2 id="drawing-heading">当前专利附图</h2><p>参考历史附图的 A4 版式 · 黑白线稿 · 正式附图标号标注</p></div><div className="uw-export-actions"><button className="button secondary" onClick={regenerateDrawing} disabled={!structureDetermined}>重新生成附图</button><button className="icon-button" aria-label="导出当前附图 SVG" disabled={!current || blockingIssues.length > 0} onClick={exportSvg}><Download size={18} /></button><button className="icon-button" aria-label="导出当前附图 PNG" disabled={!current || blockingIssues.length > 0} onClick={exportPng}><ImageDown size={18} /></button></div></div>
            <div className="uw-figure-tabs" role="tablist" aria-label="附图选择">
              {(Object.keys(figureNames) as Figure[]).map((key) => <button key={key} role="tab" aria-selected={figure === key} className={figure === key ? "active" : ""} onClick={() => setFigure(key)} disabled={!structureDetermined}>{figureNames[key]}</button>)}
            </div>
            <div className="uw-canvas" ref={canvasRef} tabIndex={0} role="region" aria-label="附图画布，可横向滚动">{model && drawing.design ? <UtilityFigure model={model} parts={drawing.design.components} figure={figure} title={drawing.design.title} /> : <div className="uw-drawing-empty"><PenLine size={32} /><h3>{!structureDetermined ? "等待确定 Patent Structure Model" : drawing.design ? "内容已修改，请重新生成" : "等待生成产品方案"}</h3><p>{!structureDetermined ? "先确定产品结构模型，系统才会开放附图生成。" : "模型已确定，附图生成失败；请检查结构几何和一致性校验。"}</p></div>}</div>
            <p className="uw-caption">{FIGURE_DESCRIPTIONS[figure]}编号和连接位置来自母模型，视图仅改变投影方向或取图范围；导出为 A4 纵向附图版式（{PATENT_DRAWING_STYLE.width} × {PATENT_DRAWING_STYLE.height} px）。</p>
            {structureModel && <div className="uw-structure-model" data-structure-model="determined"><strong>Patent Structure Model：已确定（待专业审核）</strong><p>{structureModel.components.length} 个部件 · {structureModel.connections.length} 条连接关系 · {structureModel.figureSpecs.length} 个图纸视图规范</p><p>{structureModel.workingPrinciple}</p><details><summary>查看结构模型部件与连接</summary><ul>{structureModel.components.map((component, index) => <li key={component.id}><b>{component.referenceNo || String(index + 1)} {component.name}</b>：{component.purpose}</li>)}</ul><ul>{structureModel.connections.map(connection => { const from = structureModel.components.find(component => component.id === connection.from); const to = structureModel.components.find(component => component.id === connection.to); return <li key={connection.id}>{from?.referenceNo || connection.from}、{from?.name || connection.from} → {to?.referenceNo || connection.to}、{to?.name || connection.to} · {connection.description}</li>; })}</ul></details></div>}
            {structureDetermined && drawing.design?.ai && <div className="uw-ai-origin"><strong>本图来源：AI 产品方案，已确认作为待验证初稿采用</strong><p>模型：{drawing.design.ai.model}</p><p>{drawing.design.ai.summary}</p>{drawing.design.ai.research && <PatentResearchView research={drawing.design.ai.research} />}{drawing.design.ai.concept && <details><summary>查看拟议改动与验证事项</summary><ul>{drawing.design.ai.concept.improvements.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}{drawing.design.ai.assumptions.length > 0 && <details><summary>查看生成时的假设与示意尺寸</summary><ul>{drawing.design.ai.assumptions.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}</div>}
            {structureDetermined && <p className="uw-caption">图 3 的局部目标由结构模型视图规范确定；重新生成结构后可主动更新附图。</p>}
          </section>
          <aside className="uw-side">
            <section className="uw-panel" aria-labelledby="parts-heading">
              <div className="uw-panel-heading"><div><h2 id="parts-heading">附图标记</h2><p>{structureDetermined ? `共 ${drawing.parts.length} 项，来自已确认结构模型` : "生成后自动建立编号与部件对应关系"}</p></div></div>
              <div className="uw-parts">{structureDetermined && drawing.parts.map(part => <div key={part.componentId || part.id}><span>{part.referenceNo || part.componentId?.match(/^C(\d+)$/u)?.[1].replace(/^0+(?=\d)/u, '') || part.id}</span><strong>{part.name}</strong></div>)}</div>
              <p className="uw-caption">部件来自结构模型；重新生成结构后，主动更新附图才会采用新模型编号。</p>
            </section>
          </aside>
        </div>
      ) : (
        <section className="uw-materials-panel" aria-labelledby="materials-heading">
          <div className="uw-materials-head"><div><h2 id="materials-heading">{isInvention ? "发明专利申请材料整理初稿" : "实用新型申请材料整理初稿"}</h2><p>{materials ? '当前结构模型的 V2 校验文案。' : '尚无当前结构模型的 V2 校验文案，请点击重新生成文案。'}</p></div><div className="uw-materials-actions"><button className="button secondary" onClick={regenerateMaterials} disabled={!structureDetermined || generating}>{generating ? '正在生成…' : '重新生成文案'}</button><button className="button secondary" onClick={exportWord} disabled={!materials || !current || blockingIssues.length > 0} title={wordBlockReason || "生成 Word 并嵌入三张附图"}><FileDown size={16} /> 下载 Word</button>{wordBlockReason && <span className="uw-word-block-reason" role="status" style={{ flexBasis: "100%", fontSize: 12, color: "#b45309" }}>{wordBlockReason}</span>}<button className="button secondary" onClick={exportText} disabled={!materials || !current || blockingIssues.length > 0}><FileDown size={16} /> 下载 TXT</button></div></div>
          {materials && <div className="uw-materials-grid">{textFields(materials).map(([title, content]) => <article key={title}><h3>{title}</h3><pre>{content}</pre></article>)}</div>}
          <div className="uw-warning"><strong>提交前核对：</strong>本页内容基于已确认名称及结构模型自动整理，仅作为待专业审核的初稿，不代表专利审查、检索结论或法律意见。</div>
        </section>
      )}
    </div>
  );
}
