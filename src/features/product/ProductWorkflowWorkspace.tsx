import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, CircleAlert, Cuboid, Download, FileText, Image, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Project } from '../../data';
import { Modal } from '../../components/Modal';
import { GenerationProgress } from '../utility/generationProgress';
import type { ProgressStep } from '../utility/generationProgress';
import { progressRequest } from '../utility/progressRequest';
import { TokenUsageSummary } from './TokenUsageSummary';
import {
  PREVIEW_VIEWS, applyConflictChoices, createProductWorkflow, hasCurrentCad, hasCurrentConfirmation,
  hasCurrentImageFigures, hasCurrentPreview, isPreviewConfirmation, isProductBrief, isProductCad, isProductImage, isProductMaterials,
  hasCurrentText,
  isProductPreview, isProductReview, isProductSelection, isProductWorkflowComplete, isRevisionDialogue, namingFingerprint, previewReference,
} from './productWorkflow';
import type { ProductReview, ProductWorkflow, RevisionResponse } from './productWorkflow';
import { isTextStructure, isTextDraft, TEXT_RULES_VERSION } from './productText';
import { PATENT_FIGURE_TEMPLATES } from './productPrompts';
import { previewImagesForVision, productImageBytes } from './productWordExport';
import { downloadExport, exportProductPatent } from '../export/patentExport';
import type { PatentExportFormat } from '../export/patentExport';
import './productWorkflow.css';
import { workspaceHeaders } from '../../storage/workspaceContext';

const PATH = '/api/product/';
// CAD 阶段 = 视觉模型写脚本 + FreeCAD 建模 + 投影，比纯文本阶段更久，单独放宽客户端等待时间。
const TEXT_WAIT_MS = 660000;
// 服务端 CAD 阶段总预算 1560 秒（server/productCad.ts 的 CAD_TOTAL_BUDGET_MS），客户端留出余量。
const CAD_WAIT_MS = 1860000;
const redrawDirections = [
  '保留结构，只优化外形', '用配色更清楚地区分部件', '重点结构表达更清晰', '四张视图布局更规整', '根据我的描述调整产品结构',
];
type Task = { controller: AbortController; signal: AbortSignal; generationToken?: string };

export function ProductWorkflowWorkspace({ project, onSave, onBack, visible = true, managed = false }: {
  project: Project; onSave: (projectId: string, workflow: ProductWorkflow) => void; onBack: () => void; visible?: boolean; managed?: boolean;
}) {
  const formId = useId();
  const workspaceScope = useRef(workspaceHeaders()).current;
  const [workflow, setWorkflow] = useState<ProductWorkflow>(() => project.productWorkflow?.sourceFingerprint === namingFingerprint(project)
    ? project.productWorkflow : createProductWorkflow(project));
  const stateRef = useRef(workflow);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const taskRef = useRef<Task | null>(null);
  const generationRef = useRef<{ token: string; timer: ReturnType<typeof setInterval> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [error, setError] = useState(workflow.generation?.error || '');
  const [notice, setNotice] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [redrawOpen, setRedrawOpen] = useState(false);
  const [redrawText, setRedrawText] = useState('');
  const [directions, setDirections] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loadedViews, setLoadedViews] = useState<string[]>([]);
  const [exporting, setExporting] = useState<PatentExportFormat | null>(null);
  const hasPreview = hasCurrentPreview(workflow);
  const confirmed = hasCurrentConfirmation(workflow);
  const hasCad = hasCurrentCad(workflow);
  const complete = isProductWorkflowComplete(workflow);
  const allViewsLoaded = !!workflow.previews && PREVIEW_VIEWS.every(view => loadedViews.includes(`${workflow.previews!.id}:${view.id}`));
  const conflictReview = workflow.review?.verdict === 'conflicts' ? workflow.review : undefined;
  const title = workflow.brief?.design.title || workflow.selection.proposedName;
  const activeStep = complete || confirmed ? 3 : workflow.brief ? 2 : workflow.review?.verdict === 'feasible' ? 1 : 0;

  const save = (changes: Partial<ProductWorkflow>) => {
    const next = { ...stateRef.current, ...changes, updatedAt: new Date().toISOString() };
    stateRef.current = next;
    setWorkflow(next);
    saveRef.current(project.id, next);
    return next;
  };
  const updateGeneration = (state: 'running' | 'completed' | 'failed' | 'cancelled', label: string, detail: string, steps: ProgressStep[], error?: string) => {
    const now = new Date().toISOString();
    save({ generation: { state, label, detail, steps, error, startedAt: stateRef.current.generation?.startedAt || now, updatedAt: now } });
  };
  const reportProgress = (task: Task, step: ProgressStep) => {
    if (taskRef.current !== task || task.signal.aborted) return;
    const steps = [...(stateRef.current.generation?.steps || []).slice(-5), step];
    setProgress(steps);
    updateGeneration('running', step.label, step.detail, steps);
  };
  const assertActive = (task: Task) => {
    task.signal.throwIfAborted();
    if (taskRef.current !== task) throw new DOMException('结果已经过期', 'AbortError');
  };
  const commit = (task: Task, changes: Partial<ProductWorkflow>) => { assertActive(task); return save(changes); };
  const releaseGeneration = (expectedToken?: string) => {
    const generation = generationRef.current;
    if (!generation || (expectedToken && generation.token !== expectedToken)) return;
    generationRef.current = null;
    clearInterval(generation.timer);
    void fetch('/api/generation/end', { method: 'POST', headers: { ...workspaceScope, 'Content-Type': 'application/json', 'X-Generation-Token': generation.token }, body: '{}', keepalive: true }).catch(() => {});
  };
  async function reserveGeneration(task: Task) {
    if (generationRef.current) { task.generationToken = generationRef.current.token; return generationRef.current.token; }
    // Queue waiting has no model timeout; explicit cancellation removes the waiter.
    const response = await progressRequest<{ token: string }>('/api/generation/begin', {}, step => reportProgress(task, step), task.signal);
    const token = response.data.token;
    if (typeof token !== 'string' || !token) throw new Error('无法取得专利生成名额，请重试。');
    try { assertActive(task); } catch (cause) {
      void fetch('/api/generation/end', { method: 'POST', headers: { ...workspaceScope, 'Content-Type': 'application/json', 'X-Generation-Token': token }, body: '{}', keepalive: true }).catch(() => {});
      throw cause;
    }
    task.generationToken = token;
    const timer = setInterval(() => {
      void fetch('/api/generation/heartbeat', { method: 'POST', headers: { ...workspaceScope, 'Content-Type': 'application/json', 'X-Generation-Token': token }, body: '{}' })
        .then(response => { if (!response.ok && generationRef.current?.token === token) {
          taskRef.current?.controller.abort(); releaseGeneration(); setBusy(null);
          const message = '本次生成名额已失效，请重新开始并排队。';
          setError(message); updateGeneration('failed', '生成失败', message, stateRef.current.generation?.steps || [], message);
        } })
        .catch(() => {});
    }, 30000);
    generationRef.current = { token, timer };
    return token;
  }
  async function call<T>(stage: string, body: unknown, task: Task, waitMs = TEXT_WAIT_MS): Promise<T> {
    if (stage === 'materials') waitMs = CAD_WAIT_MS;
    assertActive(task);
    const token = await reserveGeneration(task);
    const stages: Record<string, string> = { review: '逻辑校验', structure: '生成结构方案', brief: '复核结构并生成产品简介', draft: '生成申请正文', preview: '生成四张彩色预览', confirm: '确认预览', cad: '生成模型与专利附图', figure: '生成黑白结构图', materials: '复核申请文案', revise: '理解重画意见' };
    reportProgress(task, { label: stages[stage] || stage, detail: '正在处理，请稍候' });
    // 客户端等待必须长于服务端总预算（server/productWorkflowAi.ts 文本 600 秒、CAD 阶段另计），
    // 否则服务端还在生成时浏览器先中断，用户看不到服务端返回的具体原因。
    const response = await progressRequest<T>(PATH + stage, body, step => reportProgress(task, step),
      AbortSignal.any([task.signal, AbortSignal.timeout(waitMs)]), { 'X-Generation-Token': token }, usage => {
        if (taskRef.current !== task || task.signal.aborted) return;
        const current = stateRef.current;
        if (current.tokenUsage?.some(record => record.id === usage.id)) return;
        save({ tokenUsage: [...(current.tokenUsage || []), usage],
          tokenUsageIncomplete: current.tokenUsageIncomplete || current.tokenUsage === undefined });
      });
    assertActive(task);
    return response.data;
  }
  const run = async (label: string, operation: (task: Task) => Promise<void>) => {
    if (taskRef.current) return;
    const controller = new AbortController();
    const task: Task = { controller, signal: controller.signal };
    taskRef.current = task;
    setBusy(label); setError(''); setNotice(''); setProgress([{ label, detail: '正在连接服务，请稍候' }]);
    const now = new Date().toISOString();
    save({ generation: { state: 'running', label, detail: '正在连接服务，请稍候', steps: [{ label, detail: '正在连接服务，请稍候' }], startedAt: now, updatedAt: now } });
    try {
      await operation(task);
      assertActive(task);
      updateGeneration('completed', label, '本轮生成已完成', stateRef.current.generation?.steps || []);
    }
    catch (cause) {
      if (task.generationToken) releaseGeneration(task.generationToken);
      if (!task.signal.aborted && taskRef.current === task) {
        // 本轮的失败不清空任何已生成成果：正文、预览、附图和检查点都留在页面上，
        // 服务端检查点也保留失败原因，重试时接着修，不需要从头付费生成。
        // 服务端附带的具体原因（如模型输出未通过校验的条目）一并展示，便于判断是重试还是改选择。
        const details = (cause as { details?: unknown })?.details;
        const suffix = Array.isArray(details) && details.length ? `（${details.filter(item => typeof item === 'string').slice(0, 4).join('；')}）` : '';
        const message = (cause instanceof Error ? cause.message : '生成失败，请重试。') + suffix;
        setError(message);
        updateGeneration('failed', '生成失败', message, stateRef.current.generation?.steps || [], message);
      }
    } finally {
      if (taskRef.current === task) { taskRef.current = null; setBusy(null); }
    }
  };
  const cancel = () => {
    taskRef.current?.controller.abort(); taskRef.current = null; setBusy(null);
    releaseGeneration();
    updateGeneration('cancelled', '已停止', '已停止本次生成，已有成果保留，可进入项目继续。', stateRef.current.generation?.steps || []);
    setNotice('已停止等待本次生成，已有结果仍保留。生图服务或 FreeCAD 可能已开始处理，系统不会自动重复提交。');
  };
  async function finishPreview(task: Task, review: ProductReview) {
    if (review.verdict !== 'feasible') return;
    let brief = stateRef.current.brief;
    if (!brief || brief.reviewId !== review.id) {
      let structure = stateRef.current.textStructure;
      if (!structure || structure.reviewId !== review.id || structure.rulesVersion !== TEXT_RULES_VERSION) {
        const result = await call<unknown>('structure', { review }, task);
        if (!isTextStructure(result) || result.reviewId !== review.id) throw new Error('结构方案版本不匹配，请重试。');
        structure = result;
        commit(task, { textStructure: structure, textDraft: undefined });
      }
      const result = await call<unknown>('brief', { review, structure }, task);
      if (!isProductBrief(result) || result.reviewId !== review.id) throw new Error('产品简介格式或来源版本不正确，请重试。');
      brief = result;
      commit(task, { brief, textDraft: undefined, previews: undefined, preview: undefined, cad: undefined, confirmation: undefined, materials: undefined, figures: {} });
    }
    const result = await call<unknown>('preview', { brief }, task);
    if (!isProductPreview(result) || result.briefId !== brief.id || !PREVIEW_VIEWS.every(view => result.images.some(image => image.templateId === view.templateId))) throw new Error('彩色预览内容或版本无效，未替换已有成果。');
    commit(task, { previews: result, preview: undefined, cad: undefined, confirmation: undefined, materials: undefined, figures: {} });
    setLoadedViews([]);
    setNotice('四张彩色预览已生成。请核对主体图与三个视图是否同一产品，确认或继续重画。');
  }
  async function reviewAndPreview(task: Task, body: unknown) {
    const result = await call<unknown>('review', body, task);
    if (!isProductReview(result)) throw new Error('逻辑校验结果不完整，请重新校验。');
    commit(task, { selection: result.selection, review: result, brief: undefined, previews: undefined, preview: undefined,
      cad: undefined, confirmation: undefined, materials: undefined, textStructure: undefined, textDraft: undefined, figures: {}, revision: undefined });
    setResolutions({});
    if (result.verdict === 'conflicts') { setNotice('发现需要取舍的矛盾，请逐项选择处理方案后重新校验。'); return; }
    await finishPreview(task, result);
  }
  async function continuePreview(task: Task) {
    const current = stateRef.current;
    if (current.review?.verdict === 'feasible') await finishPreview(task, current.review);
    else await reviewAndPreview(task, { selection: current.selection });
  }
  /** 确认之后就按同一份简介生成：先用 FreeCAD 出统一模型和专利附图，再按这份附图清单生成文案。 */
  /** refreshCad 让已经生成过的附图按检查点重跑 CAD 阶段：只有图文核对指出的问题被修正，
   *  页面上原来的附图在修正成功前一直保留。 */
  async function finalStages(task: Task, mode: 'cad' | 'ai-figure', drawingRepairs = 0, refreshCad = false): Promise<void> {
    const current = stateRef.current;
    if (!hasCurrentConfirmation(current)) throw new Error('请先确认当前版本的四张彩色预览。');
    const brief = current.brief!;
    const confirmation = current.confirmation!;
    if (refreshCad || !hasCurrentCad(current) || current.cad?.drawingVersion !== 1) {
      if (mode === 'cad') {
        const images = await previewImagesForVision(current.previews!);
        const cad = await call<unknown>('cad', { brief, confirmation, images }, task, CAD_WAIT_MS);
        if (!isProductCad(cad) || cad.briefId !== brief.id || !cad.views.length) throw new Error('CAD 统一模型或附图内容无效，未采用该结果。');
        commit(task, { cad, materials: undefined });
      } else {
        for (const template of PATENT_FIGURE_TEMPLATES) {
          if (stateRef.current.figures[template.id]?.briefId === brief.id) continue;
          const result = await call<unknown>('figure', { brief, confirmation, templateId: template.id }, task);
          if (!isProductImage(result) || result.briefId !== brief.id || result.kind !== 'patent' || result.templateId !== template.id) throw new Error('黑白附图内容或版本不匹配，请重试该附图。');
          commit(task, { figures: { ...stateRef.current.figures, [template.id]: result } });
        }
      }
    }
    if (!hasCurrentCad(stateRef.current)) throw new Error('AI 黑白参考图已保存；它尚未通过完整标号和结构核对，不能作为成品导出。请重试专利附图生成。');
    if (!hasCurrentText(stateRef.current) || stateRef.current.materials?.textRecord?.status === 'needs_review') {
      const figureIds = hasCurrentCad(stateRef.current) ? stateRef.current.cad!.views.map(view => `cad-${view.view}`) : PATENT_FIGURE_TEMPLATES.map(template => template.id);
      let draft = stateRef.current.textDraft;
      if (!draft || draft.briefId !== brief.id || (brief.technicalSource && draft.sourceVersion !== brief.technicalSource.version)) {
        const result = await call<unknown>('draft', { brief, confirmation }, task);
        if (!isTextDraft(result) || result.briefId !== brief.id) throw new Error('正文草稿版本不匹配，请重试。');
        draft = result; commit(task, { textDraft: draft });
      }
      const previousMaterials = stateRef.current.materials?.textRecord?.status === 'needs_review' ? stateRef.current.materials : undefined;
      let result: unknown;
      try {
        result = await call<unknown>('materials', { brief, confirmation, figureIds, cad: stateRef.current.cad, draft, ...(previousMaterials ? { previousMaterials } : {}) }, task);
      } catch (cause) {
        if (task.signal.aborted || (cause as { code?: string })?.code !== 'CAD_VISUAL_MISMATCH' || drawingRepairs >= 1) throw cause;
        // The server checkpoint keeps the reviewed prose and the concrete findings.
        // Keep the current drawings on screen and re-run the CAD stage against that
        // checkpoint, so only what actually failed is repaired before the final
        // text/drawing review runs again.
        commit(task, { materials: undefined });
        reportProgress(task, { label: '修正最终图文核对问题', detail: `保留已生成正文，修正附图后重新核对（${drawingRepairs + 1}/1）` });
        return finalStages(task, 'cad', drawingRepairs + 1, true);
      }
      if (!isProductMaterials(result) || result.briefId !== brief.id || result.title !== brief.design.title) throw new Error('申请文案版本不匹配，请重试文案生成。');
      commit(task, { materials: result });
    }
    setNotice(hasCurrentCad(stateRef.current)
      ? 'FreeCAD 统一模型、专利附图与申请文案已生成，可以下载包含实际附图的 Word 文档。'
      : 'AI 黑白结构图与申请文案已生成（未使用 FreeCAD），可以下载 Word 文档。');
    if (task.generationToken) releaseGeneration(task.generationToken);
  }
  const confirmPreview = () => void run('确认预览并生成成品', async task => {
    const current = stateRef.current;
    if (!hasCurrentPreview(current)) throw new Error('请先生成当前版本的四张彩色预览。');
    for (const image of current.previews!.images) await productImageBytes(image);
    const confirmation = await call<unknown>('confirm', { brief: current.brief, preview: previewReference(current.previews!), confirmed: true }, task);
    if (!isPreviewConfirmation(confirmation) || confirmation.briefId !== current.brief!.id || confirmation.previewId !== current.previews!.id || confirmation.previewDigest !== current.previews!.digest) throw new Error('预览确认版本无效，请重试。');
    commit(task, { confirmation });
    await finalStages(task, 'cad');
  });
  const buildWithoutFreeCad = () => void run('生成 AI 黑白参考图', task => finalStages(task, 'ai-figure'));
  const resolveConflicts = () => void run('应用取舍并重新校验', async task => {
    const review = stateRef.current.review;
    if (!review || review.verdict !== 'conflicts') return;
    applyConflictChoices(review, resolutions);
    await reviewAndPreview(task, { review, resolutions });
  });
  const submitRevision = () => void run('理解重画意见', async task => {
    const current = stateRef.current;
    if (!current.brief || !hasCurrentPreview(current)) throw new Error('请先生成完整预览再提出重画意见。');
    const response = await call<RevisionResponse>('revise', { brief: current.brief, dialogue: current.revision,
      input: { text: redrawText.trim(), directions, answers: Object.entries(answers).filter(([, text]) => text.trim()).map(([questionId, text]) => ({ questionId, text: text.trim() })) } }, task);
    if (response?.status === 'needs_information' && isRevisionDialogue(response.dialogue) && response.dialogue.briefId === current.brief.id) {
      commit(task, { revision: response.dialogue }); setRedrawText(''); setDirections([]); setAnswers({}); return;
    }
    if (response?.status !== 'ready' || !isProductSelection(response.selection)) throw new Error('重画回复不完整，请重新提交意见。');
    const previous = { ...current }; delete previous.previous; delete previous.revision;
    commit(task, { previous, selection: response.selection, review: undefined, brief: undefined, previews: undefined, preview: undefined,
      cad: undefined, confirmation: undefined, materials: undefined, textStructure: undefined, textDraft: undefined, figures: {}, revision: undefined, redrawCount: current.redrawCount + 1 });
    setRedrawOpen(false); setRedrawText(''); setDirections([]); setAnswers({});
    await reviewAndPreview(task, { selection: response.selection });
  });
  const restartFromReview = () => void run('重新校验当前产品', async task => {
    const current = stateRef.current;
    if (hasCurrentPreview(current) || current.textStructure || current.textDraft) {
      const previous = { ...current }; delete previous.previous; delete previous.revision;
      commit(task, { previous });
    }
    await reviewAndPreview(task, { selection: current.selection });
  });
  const restorePrevious = () => {
    const previous = stateRef.current.previous;
    if (!previous || busy) return;
    // Preserve the number of attempted redraws; there is no maximum.
    save({ ...previous, review: previous.review, brief: previous.brief, previews: previous.previews, preview: previous.preview,
      cad: previous.cad, confirmation: previous.confirmation, materials: previous.materials, figures: previous.figures,
      textStructure: previous.textStructure, textDraft: previous.textDraft,
      revision: undefined, previous: undefined, generation: undefined, redrawCount: stateRef.current.redrawCount,
      tokenUsage: stateRef.current.tokenUsage, tokenUsageIncomplete: stateRef.current.tokenUsageIncomplete });
    setLoadedViews([]); setError(''); setNotice('已恢复上一版产品简介和预览，未重新调用生图模型。');
  };
  const exportDocument = async (format: PatentExportFormat) => {
    if (exporting) return;
    setExporting(format); setError('');
    const snapshot = structuredClone(stateRef.current);
    const label = format === 'pdf' ? 'PDF' : 'Word';
    try {
      downloadExport(await exportProductPatent(snapshot, format));
    setNotice(snapshot.materials?.textRecord?.status === 'needs_review'
      ? '文本初稿已生成，仍有待复核问题；可展开文本复核记录查看并继续修正。'
      : hasCurrentCad(snapshot)
        ? `${label} 文档已导出：摘要、权利要求书、说明书和 ${snapshot.cad!.views.length} 张专利附图；使用前请专业核实。`
        : `${label} 文档已导出：摘要、权利要求书、说明书和 AI 黑白结构图；使用前请专业核实。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : `${label} 导出失败。`); }
    finally { setExporting(null); }
  };

  useEffect(() => {
    // Defer initial work so React StrictMode's probe does not create a second billable request.
    const timer = setTimeout(() => {
      if (project.productWorkflow?.sourceFingerprint === stateRef.current.sourceFingerprint && !stateRef.current.review && !stateRef.current.generation && isProductSelection(stateRef.current.selection)) {
        saveRef.current(project.id, stateRef.current);
        void run('检查产品逻辑', task => reviewAndPreview(task, { selection: stateRef.current.selection }));
      }
    }, 0);
    const onPageHide = () => { taskRef.current?.controller.abort(); releaseGeneration(); };
    window.addEventListener('pagehide', onPageHide);
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', onPageHide); taskRef.current?.controller.abort(); taskRef.current = null; releaseGeneration(); };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- A keyed workspace owns exactly one project and resumes only on explicit retry after a failure.
  }, [project.id]);

  useEffect(() => {
    if (visible && !managed) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [visible, managed]);

  return <div className="product-workflow" data-testid="product-workflow">
    <button className="un-back" onClick={() => { if (!managed) { if (busy) cancel(); releaseGeneration(); } onBack(); }}><ArrowLeft size={16} />{managed ? '返回项目列表' : '返回修改名称与特征'}</button>
    <header className="pw-heading"><div><div className="un-eyebrow">PRODUCT STUDIO · {workflow.selection.patentType === 'invention' ? '发明专利' : '实用新型'}</div>
      <h1>{title}</h1></div></header>
    {(complete || !!workflow.tokenUsage?.length) && <TokenUsageSummary records={workflow.tokenUsage} incomplete={workflow.tokenUsageIncomplete} />}
    <ol className="pw-steps" aria-label="产品生成流程">{['逻辑校验与去矛盾', '详细产品简介', '四张彩色预览与重画', '确认并生成成品'].map((label, index) =>
      <li key={label} className={index < activeStep || complete ? 'done' : index === activeStep ? 'active' : ''} aria-current={index === activeStep ? 'step' : undefined}>
        <span>{index < activeStep || complete ? <Check size={16} /> : `0${index + 1}`}</span><strong>{label}</strong></li>)}</ol>
    {busy && <div className="pw-progress"><GenerationProgress title={busy} label="产品生成" steps={progress} note="可以切换到项目管理查看实时进度，生成会继续。" /><button className="button secondary" onClick={cancel}><X size={15} />停止等待</button></div>}
    {error && <div className="pw-error" role="alert"><CircleAlert size={18} /><div><p>{error}</p>{!busy && workflow.review && <button className="pw-restore" onClick={restartFromReview}>从逻辑校验重新生成</button>}</div></div>}
    {notice && <p className="pw-notice" role="status">{notice}</p>}
    {!isProductSelection(workflow.selection) && <p className="pw-error" role="alert">当前项目缺少已选产品特征，请返回名称与特征页面补充后继续。</p>}
    {conflictReview && <section className="pw-panel pw-conflicts" aria-labelledby={`${formId}-conflicts-title`}><div className="pw-section-head"><CircleAlert size={21} /><div><h2 id={`${formId}-conflicts-title`}>请先消除这些产品矛盾</h2><p>{conflictReview.summary}</p></div></div>
      {conflictReview.conflicts.map(conflict => <fieldset key={conflict.id} disabled={!!busy}><legend>{conflict.title}</legend><p>{conflict.reason}</p>
        <div className="pw-options">{conflict.options.map(option => <label key={option.id} className={resolutions[conflict.id] === option.id ? 'selected' : ''}>
          <input type="radio" name={`${formId}-conflict-${conflict.id}`} value={option.id} checked={resolutions[conflict.id] === option.id} onChange={() => setResolutions(current => ({ ...current, [conflict.id]: option.id }))} />
          <span><strong>{option.label}</strong><small>{option.explanation}</small>
            {option.removeIds.map(id => <small className="pw-removal" key={id}>删除：{conflictReview.selection.choices.find(choice => choice.id === id)?.text}</small>)}
            {option.replacements.map(item => <small key={item.id}>改为：{item.text}</small>)}{option.proposedName && <small>名称同步为：{option.proposedName}</small>}</span></label>)}</div></fieldset>)}
      <button className="button primary" disabled={!!busy || conflictReview.conflicts.some(conflict => !resolutions[conflict.id])} onClick={resolveConflicts}><ShieldCheck size={16} />应用选择并重新校验</button>
      <p className="pw-muted">只应用你明确选择的删改；重新检查通过后，才会生成简介和图片。</p></section>}
    <div className="pw-layout"><div className="pw-main">
      <section className="pw-panel" aria-labelledby={`${formId}-preview-title`}><div className="pw-section-head"><Image size={21} /><div><h2 id={`${formId}-preview-title`}>彩色产品预览（4 张）</h2></div><span className="pw-tag">{workflow.redrawCount ? `已重画 ${workflow.redrawCount} 次` : '初次预览'}</span></div>
        {hasPreview ? <><div className="pw-previews">{PREVIEW_VIEWS.map(view => {
          const image = workflow.previews!.images.find(item => item.templateId === view.templateId)!;
          const loadKey = `${workflow.previews!.id}:${view.id}`;
          return <figure key={view.id}><figcaption>{view.title}</figcaption>
            <img key={loadKey} src={image.dataUrl} alt={`${title}的彩色${view.title}`} onLoad={() => setLoadedViews(current => current.includes(loadKey) ? current : [...current, loadKey])}
              onError={() => { setLoadedViews(current => current.filter(id => id !== loadKey)); setError(`${view.title}无法解码，不能确认此预览。请重画或恢复上一版。`); }} /></figure>;
        })}</div>
          <div className="pw-actions"><button className="button primary" disabled={!!busy || confirmed || !allViewsLoaded} onClick={confirmPreview}><CheckCheck size={17} />{confirmed ? '已确认此预览' : '确认预览并生成成品'}</button>
            <button className="button secondary" disabled={!!busy} onClick={() => setRedrawOpen(true)}><RotateCcw size={16} />{workflow.revision ? '继续补充重画意见' : '重新画'}</button></div>
          <div className="pw-actions">{PATENT_FIGURE_TEMPLATES.map(template => <button key={template.id} className="button secondary" disabled={!!busy || !confirmed || hasCurrentImageFigures(workflow, [template.id])} onClick={buildWithoutFreeCad}><FileText size={15} />生成 AI 黑白参考图</button>)}</div>
          {workflow.preview && <p className="pw-muted">已保留旧版单张三视图预览作对照，它不参与确认，也不会用于最终文档。</p>}</>
          : <div className="pw-empty"><Sparkles size={34} /><strong>{conflictReview ? '消除矛盾后生成预览' : busy ? '正在生成主体图及其三个视图' : '继续生成当前产品预览'}</strong><p>不会用占位图或旧版几何图冒充生图结果。</p>
            {!busy && !conflictReview && <button className="button primary" disabled={!isProductSelection(workflow.selection)} onClick={() => void run('继续生成产品预览', continuePreview)}>{workflow.review ? '继续生成预览' : '检查逻辑并生成预览'}</button>}</div>}
        {workflow.previous && <button className="pw-restore" disabled={!!busy} onClick={restorePrevious}><RotateCcw size={14} />放弃本次修改，恢复上一版预览</button>}
      </section>
      <section className="pw-panel" aria-labelledby={`${formId}-final-title`}><div className="pw-section-head"><Cuboid size={21} /><div><h2 id={`${formId}-final-title`}>最终文档与专利附图</h2></div>{complete && <span className="pw-tag success">已完成</span>}</div>
        {!confirmed ? <p className="pw-muted">请先确认彩色预览。在此之前不会生成 CAD 模型、文案或附图。</p> : <>
          <ul className="pw-deliverables"><li>{workflow.materials ? <Check size={16} /> : <FileText size={16} />}申请文案 {workflow.materials ? '已生成' : '待生成'}</li>
            {workflow.cad ? workflow.cad.views.map((view, i) => <li key={view.view}><Check size={16} />图{i + 1} {view.title} 已生成</li>) : <li><Cuboid size={16} />按产品结构生成必要附图</li>}
            {PATENT_FIGURE_TEMPLATES.map(template => workflow.figures[template.id] && <li key={template.id}><Check size={16} />{template.title}（AI 参考图）已生成</li>)}</ul>
          {hasCad && <details className="pw-details" open><summary>查看 FreeCAD 专利附图与建模说明</summary>
            <p className="pw-muted">FreeCAD {workflow.cad!.freecadVersion} · 三角面 {workflow.cad!.triangleCount} 个</p>
            <p>{workflow.cad!.summary}</p>
            {!!workflow.cad!.assumptions.length && <ul className="pw-choices">{workflow.cad!.assumptions.map(item => <li key={item}>{item}</li>)}</ul>}
            {workflow.cad!.views.map((drawing, index) => { const view = { id: drawing.view, title: drawing.title };
              return <div key={view.id}><h3>图{index + 1} {view.title}</h3><img className="pw-patent-image" src={`data:image/svg+xml;utf8,${encodeURIComponent(drawing.svg)}`} alt={`${title}的${view.title}专利附图`} /></div>; })}</details>}
          {PATENT_FIGURE_TEMPLATES.map(template => workflow.figures[template.id] && <details className="pw-details" key={template.id}><summary>查看 AI 黑白{template.title}</summary><img className="pw-patent-image" src={workflow.figures[template.id].dataUrl} alt={template.title} /></details>)}
          {workflow.materials && <details className="pw-details"><summary>查看申请材料正文</summary><h3>摘要</h3><p>{workflow.materials.abstract}</p><h3>权利要求</h3>{workflow.materials.claims.map(claim => <p key={claim}>{claim}</p>)}
            {([['技术领域', 'technicalField'], ['背景技术', 'background'], ['内容', 'content'], ['附图说明', 'drawings'], ['具体实施方式', 'embodiment']] as const).map(([heading, key]) => <div key={key}><h3>{heading}</h3><p className="pw-prose">{workflow.materials![key]}</p></div>)}</details>}
          {workflow.materials?.textRecord && <details className="pw-details"><summary>查看文本复核记录{workflow.materials.textRecord.status === 'needs_review' ? '（仍有待复核问题）' : ''}</summary>
            {workflow.materials.textRecord.review.findings.map((f, i) => <p key={i}>{f.location}：{f.issue}；{f.resolution}</p>)}
            {workflow.materials.textRecord.review.unresolved.map((item, i) => <p key={i}>{item}</p>)}
            {workflow.materials.textRecord.status === 'needs_review' && <button className="button secondary" disabled={!!busy} onClick={() => void run('继续复核申请文案', task => finalStages(task, 'cad'))}>继续复核文案</button>}
          </details>}
          {!complete && !busy && <div className="pw-actions"><button className="button secondary" onClick={() => void run(hasCad ? '补齐未完成的文案' : '重试未完成的文案或附图', task => finalStages(task, 'cad'))}><RotateCcw size={15} />重试未完成的文案或附图</button></div>}
        </>}
        <div className="pw-actions">
          <button className="button primary" disabled={!complete || !!busy || !!exporting} onClick={() => void exportDocument('word')}><Download size={16} />{exporting === 'word' ? '正在打包 Word…' : '下载 Word 成品（.docx）'}</button>
          <button className="button secondary" disabled={!complete || !!busy || !!exporting} onClick={() => void exportDocument('pdf')}><Download size={16} />{exporting === 'pdf' ? '正在生成 PDF…' : '下载 PDF 成品（.pdf）'}</button>
        </div>
      </section>
    </div><aside className="pw-side">
      <section className="pw-panel"><h2>当前生效选择</h2><p className="pw-muted">{workflow.selection.company} · {workflow.selection.product}</p><ul className="pw-choices">{workflow.selection.choices.map(choice => <li key={choice.id}>{choice.text}</li>)}</ul>{workflow.selection.visualPreferences && <p className="pw-prose">绘图要求：{workflow.selection.visualPreferences}</p>}</section>
    </aside></div>
    {redrawOpen && visible && <Modal title="告诉我们这次想怎么改" wide onClose={() => { if (busy) cancel(); setRedrawOpen(false); }}>
      <div className="pw-revision"><p>可以只调整视觉，也可以修改产品结构。不设固定问答轮数，信息足够形成完整产品后就直接重画四张预览。</p>
        {workflow.revision && <div className="pw-revision-questions"><p><strong>{workflow.revision.summary}</strong></p>{workflow.revision.questions.map(question => <fieldset key={question.id} disabled={!!busy}><legend>{question.question}</legend>
          {question.options.map(option => <label key={option}><input type="radio" name={`${formId}-rev-${question.id}`} checked={answers[question.id] === option} onChange={() => setAnswers(current => ({ ...current, [question.id]: option }))} />{option}</label>)}
          <label>自己的答案<input aria-label={`${question.question}：自定义回答`} value={question.options.includes(answers[question.id]) ? '' : answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} maxLength={2000} placeholder="也可以直接说明你希望如何处理" /></label></fieldset>)}</div>}
        <fieldset disabled={!!busy}><legend>重画方向（可多选）</legend><div className="pw-revision-directions">{redrawDirections.map(direction => <label key={direction}><input type="checkbox" checked={directions.includes(direction)} onChange={() => setDirections(current => current.includes(direction) ? current.filter(item => item !== direction) : [...current, direction])} />{direction}</label>)}</div></fieldset>
        <label htmlFor={`${formId}-revision-text`}>修改说明</label><textarea id={`${formId}-revision-text`} data-autofocus rows={4} value={redrawText} onChange={event => setRedrawText(event.target.value)} maxLength={4000} disabled={!!busy} placeholder="例如：保留滑轨和锁定结构，外壳改成圆角，主体用蓝色，并把锁扣结构画得更清楚。" />
        {error && <p className="pw-error" role="alert">{error}</p>}{busy && <p className="pw-muted" role="status">{progress.at(-1)?.detail || '正在理解修改意见…'}</p>}
        <div className="modal-actions"><button className="button secondary" onClick={() => { if (busy) cancel(); setRedrawOpen(false); }}>暂不修改</button>
          <button className="button primary" disabled={!!busy || (!redrawText.trim() && !directions.length && !Object.values(answers).some(text => text.trim())) || !!workflow.revision?.questions.some(question => !answers[question.id]?.trim())} onClick={submitRevision}><Sparkles size={16} />{busy ? '正在分析修改意见…' : workflow.revision ? '提交补充并继续' : '提交修改并重画'}</button></div>
      </div></Modal>}
  </div>;
}
