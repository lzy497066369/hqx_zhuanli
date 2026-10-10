import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, CircleAlert, Cuboid, Download, FileText, Image, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Project } from '../../data';
import { Modal } from '../../components/Modal';
import { GenerationProgress } from '../utility/generationProgress';
import type { ProgressStep } from '../utility/generationProgress';
import { progressRequest } from '../utility/progressRequest';
import {
  CAD_VIEWS, LOGIC_DIMENSIONS, PREVIEW_VIEWS, applyConflictChoices, createProductWorkflow, hasCurrentCad, hasCurrentConfirmation,
  hasCurrentImageFigures, hasCurrentPreview, isPreviewConfirmation, isProductBrief, isProductCad, isProductImage, isProductMaterials,
  isProductPreview, isProductReview, isProductSelection, isProductWorkflowComplete, isRevisionDialogue, namingFingerprint, previewReference,
} from './productWorkflow';
import type { ProductReview, ProductWorkflow, RevisionResponse } from './productWorkflow';
import { PATENT_FIGURE_TEMPLATES } from './productPrompts';
import { createProductWordBlob, previewImagesForVision, productImageBytes, productWordFilename } from './productWordExport';
import './productWorkflow.css';

const PATH = '/api/product/';
// CAD 阶段 = 视觉模型写脚本 + FreeCAD 建模 + 投影，比纯文本阶段更久，单独放宽客户端等待时间。
const TEXT_WAIT_MS = 660000;
const CAD_WAIT_MS = 900000;
const redrawDirections = [
  '保留结构，只优化外形', '用配色更清楚地区分部件', '重点结构表达更清晰', '四张视图布局更规整', '根据我的描述调整产品结构',
];
type Task = { controller: AbortController; signal: AbortSignal };

export function ProductWorkflowWorkspace({ project, onSave, onBack }: {
  project: Project; onSave: (projectId: string, workflow: ProductWorkflow) => void; onBack: () => void;
}) {
  const [workflow, setWorkflow] = useState<ProductWorkflow>(() => project.productWorkflow?.sourceFingerprint === namingFingerprint(project)
    ? project.productWorkflow : createProductWorkflow(project));
  const stateRef = useRef(workflow);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const taskRef = useRef<Task | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [redrawOpen, setRedrawOpen] = useState(false);
  const [redrawText, setRedrawText] = useState('');
  const [directions, setDirections] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loadedViews, setLoadedViews] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
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
  const assertActive = (task: Task) => {
    task.signal.throwIfAborted();
    if (taskRef.current !== task) throw new DOMException('结果已经过期', 'AbortError');
  };
  const commit = (task: Task, changes: Partial<ProductWorkflow>) => { assertActive(task); return save(changes); };
  async function call<T>(stage: string, body: unknown, task: Task, waitMs = TEXT_WAIT_MS): Promise<T> {
    assertActive(task);
    // 客户端等待必须长于服务端总预算（server/productWorkflowAi.ts 文本 600 秒、CAD 阶段另计），
    // 否则服务端还在生成时浏览器先中断，用户看不到服务端返回的具体原因。
    const response = await progressRequest<T>(PATH + stage, body, step => {
      if (taskRef.current === task && !task.signal.aborted) setProgress(steps => [...steps.slice(-5), step]);
    }, AbortSignal.any([task.signal, AbortSignal.timeout(waitMs)]));
    assertActive(task);
    return response.data;
  }
  const run = async (label: string, operation: (task: Task) => Promise<void>) => {
    if (taskRef.current) return;
    const controller = new AbortController();
    const task = { controller, signal: controller.signal };
    taskRef.current = task;
    setBusy(label); setError(''); setNotice(''); setProgress([{ label, detail: '正在连接服务，请稍候' }]);
    try { await operation(task); }
    catch (cause) {
      if (!task.signal.aborted && taskRef.current === task) setError(cause instanceof Error ? cause.message : '生成失败，请重试。');
    } finally {
      if (taskRef.current === task) { taskRef.current = null; setBusy(null); }
    }
  };
  const cancel = () => {
    taskRef.current?.controller.abort(); taskRef.current = null; setBusy(null);
    setNotice('已停止等待本次生成，已有结果仍保留。生图服务或 FreeCAD 可能已开始处理，系统不会自动重复提交。');
  };
  async function finishPreview(task: Task, review: ProductReview) {
    if (review.verdict !== 'feasible') return;
    let brief = stateRef.current.brief;
    if (!brief || brief.reviewId !== review.id) {
      const result = await call<unknown>('brief', { review }, task);
      if (!isProductBrief(result) || result.reviewId !== review.id) throw new Error('产品简介格式或来源版本不正确，请重试。');
      brief = result;
      commit(task, { brief, previews: undefined, preview: undefined, cad: undefined, confirmation: undefined, materials: undefined, figures: {} });
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
      cad: undefined, confirmation: undefined, materials: undefined, figures: {}, revision: undefined });
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
  async function finalStages(task: Task, mode: 'cad' | 'ai-figure') {
    const current = stateRef.current;
    if (!hasCurrentConfirmation(current)) throw new Error('请先确认当前版本的四张彩色预览。');
    const brief = current.brief!;
    const confirmation = current.confirmation!;
    if (!hasCurrentCad(current) && !hasCurrentImageFigures(current, PATENT_FIGURE_TEMPLATES.map(template => template.id))) {
      if (mode === 'cad') {
        const images = await previewImagesForVision(current.previews!);
        const cad = await call<unknown>('cad', { brief, confirmation, images }, task, CAD_WAIT_MS);
        if (!isProductCad(cad) || cad.briefId !== brief.id || !cad.views.length) throw new Error('CAD 统一模型或附图内容无效，未采用该结果。');
        commit(task, { cad });
      } else {
        for (const template of PATENT_FIGURE_TEMPLATES) {
          if (stateRef.current.figures[template.id]?.briefId === brief.id) continue;
          const result = await call<unknown>('figure', { brief, confirmation, templateId: template.id }, task);
          if (!isProductImage(result) || result.briefId !== brief.id || result.kind !== 'patent' || result.templateId !== template.id) throw new Error('黑白附图内容或版本不匹配，请重试该附图。');
          commit(task, { figures: { ...stateRef.current.figures, [template.id]: result } });
        }
      }
    }
    if (stateRef.current.materials?.briefId !== brief.id) {
      const figureIds = hasCurrentCad(stateRef.current) ? CAD_VIEWS.map(view => `cad-${view.id}`) : PATENT_FIGURE_TEMPLATES.map(template => template.id);
      const result = await call<unknown>('materials', { brief, confirmation, figureIds }, task);
      if (!isProductMaterials(result) || result.briefId !== brief.id || result.title !== brief.design.title) throw new Error('申请文案版本不匹配，请重试文案生成。');
      commit(task, { materials: result });
    }
    setNotice(hasCurrentCad(stateRef.current)
      ? 'FreeCAD 统一模型、专利附图与申请文案已生成，可以下载包含实际附图和建模记录的 Word 文档。'
      : 'AI 黑白结构图与申请文案已生成（未使用 FreeCAD），可以下载 Word 文档。');
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
  const buildWithoutFreeCad = () => void run('改用 AI 黑白结构图生成成品', task => finalStages(task, 'ai-figure'));
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
      cad: undefined, confirmation: undefined, materials: undefined, figures: {}, revision: undefined, redrawCount: current.redrawCount + 1 });
    setRedrawOpen(false); setRedrawText(''); setDirections([]); setAnswers({});
    await reviewAndPreview(task, { selection: response.selection });
  });
  const restartFromReview = () => void run('重新校验当前产品', async task => {
    const current = stateRef.current;
    if (hasCurrentPreview(current)) {
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
      revision: undefined, previous: undefined, redrawCount: stateRef.current.redrawCount });
    setLoadedViews([]); setError(''); setNotice('已恢复上一版产品简介和预览，未重新调用生图模型。');
  };
  const exportWord = async () => {
    if (exporting) return;
    setExporting(true); setError('');
    try {
      const blob = await createProductWordBlob(stateRef.current);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = productWordFilename(stateRef.current);
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(hasCurrentCad(stateRef.current)
        ? 'Word 文档已导出：摘要、权利要求书、说明书和 4 张由 FreeCAD 统一模型投影的专利附图；使用前请专业核实。'
        : 'Word 文档已导出：摘要、权利要求书、说明书和 AI 黑白结构图；使用前请专业核实。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Word 导出失败。'); }
    finally { setExporting(false); }
  };

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    // Defer initial work so React StrictMode's probe does not create a second billable request.
    const timer = setTimeout(() => {
      if (project.productWorkflow?.sourceFingerprint === stateRef.current.sourceFingerprint && !stateRef.current.review && isProductSelection(stateRef.current.selection)) {
        saveRef.current(project.id, stateRef.current);
        void run('检查产品逻辑', task => reviewAndPreview(task, { selection: stateRef.current.selection }));
      }
    }, 0);
    return () => { clearTimeout(timer); taskRef.current?.controller.abort(); taskRef.current = null; };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- A keyed workspace owns exactly one project and resumes only on explicit retry after a failure.
  }, [project.id]);

  return <div className="product-workflow" data-testid="product-workflow">
    <button className="un-back" onClick={onBack}><ArrowLeft size={16} />返回修改名称与特征</button>
    <header className="pw-heading"><div><div className="un-eyebrow">PRODUCT STUDIO · {workflow.selection.patentType === 'invention' ? '发明专利' : '实用新型'}</div>
      <h1>{title}</h1><p>先消除逻辑矛盾，再看四张彩色预览；满意后由 FreeCAD 统一建模，再生成文档与专利附图。</p></div>
      <span className="pw-badge"><ShieldCheck size={16} />同一简介 · 同一版本</span></header>
    <ol className="pw-steps" aria-label="产品生成流程">{['逻辑校验与去矛盾', '详细产品简介', '四张彩色预览与重画', '确认并生成成品'].map((label, index) =>
      <li key={label} className={index < activeStep || complete ? 'done' : index === activeStep ? 'active' : ''} aria-current={index === activeStep ? 'step' : undefined}>
        <span>{index < activeStep || complete ? <Check size={16} /> : `0${index + 1}`}</span><strong>{label}</strong></li>)}</ol>
    <p className="pw-boundary">AI 检查用于识别方案中的逻辑矛盾，不等于工程、安全或专利性认证。FreeCAD 模型由视觉模型按预览自动编写脚本生成，尺寸为推定值；最终材料仍需发明人和专业人员核实。</p>
    {busy && <div className="pw-progress"><GenerationProgress title={busy} label="产品生成" steps={progress} note="四个视角各自只提交一次生图请求；FreeCAD 建模脚本在隔离目录中执行，失败不会自动重复提交。" /><button className="button secondary" onClick={cancel}><X size={15} />停止等待</button></div>}
    {error && <div className="pw-error" role="alert"><CircleAlert size={18} /><div><p>{error}</p>{!busy && workflow.review && <button className="pw-restore" onClick={restartFromReview}>从逻辑校验重新生成</button>}</div></div>}
    {notice && <p className="pw-notice" role="status">{notice}</p>}
    {!isProductSelection(workflow.selection) && <p className="pw-error" role="alert">当前项目缺少已选产品特征，请返回名称与特征页面补充后继续。</p>}
    {conflictReview && <section className="pw-panel pw-conflicts" aria-labelledby="pw-conflicts-title"><div className="pw-section-head"><CircleAlert size={21} /><div><h2 id="pw-conflicts-title">请先消除这些产品矛盾</h2><p>{conflictReview.summary}</p></div></div>
      {conflictReview.conflicts.map(conflict => <fieldset key={conflict.id} disabled={!!busy}><legend>{conflict.title}</legend><p>{conflict.reason}</p>
        <div className="pw-options">{conflict.options.map(option => <label key={option.id} className={resolutions[conflict.id] === option.id ? 'selected' : ''}>
          <input type="radio" name={`conflict-${conflict.id}`} value={option.id} checked={resolutions[conflict.id] === option.id} onChange={() => setResolutions(current => ({ ...current, [conflict.id]: option.id }))} />
          <span><strong>{option.label}</strong><small>{option.explanation}</small>
            {option.removeIds.map(id => <small className="pw-removal" key={id}>删除：{conflictReview.selection.choices.find(choice => choice.id === id)?.text}</small>)}
            {option.replacements.map(item => <small key={item.id}>改为：{item.text}</small>)}{option.proposedName && <small>名称同步为：{option.proposedName}</small>}</span></label>)}</div></fieldset>)}
      <button className="button primary" disabled={!!busy || conflictReview.conflicts.some(conflict => !resolutions[conflict.id])} onClick={resolveConflicts}><ShieldCheck size={16} />应用选择并重新校验</button>
      <p className="pw-muted">只应用你明确选择的删改；重新检查通过后，才会生成简介和图片。</p></section>}
    <div className="pw-layout"><div className="pw-main">
      <section className="pw-panel" aria-labelledby="pw-preview-title"><div className="pw-section-head"><Image size={21} /><div><h2 id="pw-preview-title">彩色产品预览（4 张并行）</h2><p>主体图、前视图、俯视图、右视图同时生成，必须是同一产品的同一套结构</p></div><span className="pw-tag">{workflow.redrawCount ? `已重画 ${workflow.redrawCount} 次` : '初次预览'}</span></div>
        {hasPreview ? <><div className="pw-previews">{PREVIEW_VIEWS.map(view => {
          const image = workflow.previews!.images.find(item => item.templateId === view.templateId)!;
          const loadKey = `${workflow.previews!.id}:${view.id}`;
          return <figure key={view.id}><figcaption>{view.title}</figcaption>
            <img key={loadKey} src={image.dataUrl} alt={`${title}的彩色${view.title}`} onLoad={() => setLoadedViews(current => current.includes(loadKey) ? current : [...current, loadKey])}
              onError={() => { setLoadedViews(current => current.filter(id => id !== loadKey)); setError(`${view.title}无法解码，不能确认此预览。请重画或恢复上一版。`); }} /></figure>;
        })}</div>
          <div className="pw-actions"><button className="button primary" disabled={!!busy || confirmed || !allViewsLoaded} onClick={confirmPreview}><CheckCheck size={17} />{confirmed ? '已确认此预览' : '确认预览并生成成品'}</button>
            <button className="button secondary" disabled={!!busy} onClick={() => setRedrawOpen(true)}><RotateCcw size={16} />{workflow.revision ? '继续补充重画意见' : '重新画'}</button></div>
          <p className="pw-muted">必须四张都加载成功才能确认。不限制重画次数；若修改涉及结构，会重新进行逻辑检查。只有你确认的新版本才用于最终文档。</p>
          {confirmed && !complete && !busy && <p className="pw-muted">确认后先由 FreeCAD 生成统一模型与专利附图，再按这份附图清单生成申请文案。若 FreeCAD 不可用，可改用 AI 黑白结构图。</p>}
          <div className="pw-actions">{PATENT_FIGURE_TEMPLATES.map(template => <button key={template.id} className="button secondary" disabled={!!busy || !confirmed || hasCurrentImageFigures(workflow, [template.id])} onClick={buildWithoutFreeCad}><FileText size={15} />改用 AI 黑白结构图</button>)}</div>
          {workflow.preview && <p className="pw-muted">已保留旧版单张三视图预览作对照，它不参与确认，也不会用于最终文档。</p>}</>
          : <div className="pw-empty"><Sparkles size={34} /><strong>{conflictReview ? '消除矛盾后生成预览' : busy ? '正在并行生成四张产品预览' : '继续生成当前产品预览'}</strong><p>不会用占位图或旧版几何图冒充生图结果。</p>
            {!busy && !conflictReview && <button className="button primary" disabled={!isProductSelection(workflow.selection)} onClick={() => void run('继续生成产品预览', continuePreview)}>{workflow.review ? '继续生成预览' : '检查逻辑并生成预览'}</button>}</div>}
        {workflow.previous && <button className="pw-restore" disabled={!!busy} onClick={restorePrevious}><RotateCcw size={14} />放弃本次修改，恢复上一版预览</button>}
      </section>
      <section className="pw-panel" aria-labelledby="pw-final-title"><div className="pw-section-head"><Cuboid size={21} /><div><h2 id="pw-final-title">最终文档与专利附图</h2><p>FreeCAD 统一模型投影出立体图与三视图，作为说明书附图写入 Word</p></div>{complete && <span className="pw-tag success">已完成</span>}</div>
        {!confirmed ? <p className="pw-muted">请先确认彩色预览。在此之前不会生成 CAD 模型、文案或附图。</p> : <>
          <ul className="pw-deliverables"><li>{workflow.materials ? <Check size={16} /> : <FileText size={16} />}申请文案 {workflow.materials ? '已生成' : '待生成'}</li>
            {CAD_VIEWS.map(view => <li key={view.id}>{workflow.cad?.views.some(item => item.view === view.id) ? <Check size={16} /> : <Cuboid size={16} />}{view.title} {workflow.cad?.views.some(item => item.view === view.id) ? '已生成' : '待生成'}</li>)}
            {PATENT_FIGURE_TEMPLATES.map(template => workflow.figures[template.id] && <li key={template.id}><Check size={16} />{template.title}（AI 备用图）已生成</li>)}</ul>
          {hasCad && <details className="pw-details" open><summary>查看 FreeCAD 专利附图与建模说明</summary>
            <p className="pw-muted">FreeCAD {workflow.cad!.freecadVersion} · 三角面 {workflow.cad!.triangleCount} 个</p>
            <p>{workflow.cad!.summary}</p>
            {!!workflow.cad!.assumptions.length && <ul className="pw-choices">{workflow.cad!.assumptions.map(item => <li key={item}>{item}</li>)}</ul>}
            {CAD_VIEWS.map(view => { const drawing = workflow.cad!.views.find(item => item.view === view.id); if (!drawing) return null;
              return <div key={view.id}><h3>{view.title}</h3><img className="pw-patent-image" src={`data:image/svg+xml;utf8,${encodeURIComponent(drawing.svg)}`} alt={`${title}的${view.title}专利附图`} /></div>; })}</details>}
          {PATENT_FIGURE_TEMPLATES.map(template => workflow.figures[template.id] && <details className="pw-details" key={template.id}><summary>查看 AI 黑白{template.title}</summary><img className="pw-patent-image" src={workflow.figures[template.id].dataUrl} alt={template.title} /></details>)}
          {workflow.materials && <details className="pw-details"><summary>查看申请材料正文</summary><h3>摘要</h3><p>{workflow.materials.abstract}</p><h3>权利要求</h3>{workflow.materials.claims.map(claim => <p key={claim}>{claim}</p>)}
            {([['技术领域', 'technicalField'], ['背景技术', 'background'], ['内容', 'content'], ['附图说明', 'drawings'], ['具体实施方式', 'embodiment']] as const).map(([heading, key]) => <div key={key}><h3>{heading}</h3><p className="pw-prose">{workflow.materials![key]}</p></div>)}</details>}
          {!complete && !busy && <div className="pw-actions"><button className="button secondary" onClick={() => void run(hasCad ? '补齐未完成的文案' : '重试未完成的文案或附图', task => finalStages(task, hasCad ? 'cad' : 'ai-figure'))}><RotateCcw size={15} />重试未完成的文案或附图</button></div>}
        </>}
        <div className="pw-actions"><button className="button primary" disabled={!complete || !!busy || exporting} onClick={() => void exportWord()}><Download size={16} />{exporting ? '正在打包 Word…' : '下载 Word 成品（.docx）'}</button></div>
        <p className="pw-muted">Word 嵌入实际黑白图片，不依赖临时图片网址；FreeCAD 附图为真实投影线稿，不是生成图片。</p>
      </section>
    </div><aside className="pw-side">
      <section className="pw-panel"><h2><ShieldCheck size={18} />逻辑检查</h2>{workflow.review ? <><p className={conflictReview ? '' : 'pw-pass'}>{conflictReview ? '存在需要处理的矛盾' : '基于当前信息未发现逻辑矛盾'}</p><p>{workflow.review.summary}</p><ul className="pw-checks">{workflow.review.checks.map(check => <li key={check.dimension} className={check.status}><strong>{LOGIC_DIMENSIONS[check.dimension]}</strong><span>{check.explanation}</span></li>)}</ul>
        {!!workflow.review.assumptions.length && <details className="pw-details"><summary>合理推定与核实事项</summary><ul>{workflow.review.assumptions.map(item => <li key={item}>{item}</li>)}</ul></details>}</> : <p className="pw-muted">用户所有选择会连同初步名称一起交给大模型，进行独立的交叉检查。</p>}</section>
      <section className="pw-panel"><h2><FileText size={18} />详细产品简介</h2>{workflow.brief ? <><p>{workflow.brief.design.overview}</p><details className="pw-details"><summary>展开完整产品简介</summary><pre>{workflow.brief.description}</pre></details></> : <p className="pw-muted">逻辑检查通过后自动生成，作为全部图片、CAD 模型与文案的共同依据。</p>}</section>
      <section className="pw-panel"><h2>当前生效选择</h2><p className="pw-muted">{workflow.selection.company} · {workflow.selection.product}</p><ul className="pw-choices">{workflow.selection.choices.map(choice => <li key={choice.id}>{choice.text}</li>)}</ul>{workflow.selection.visualPreferences && <p className="pw-prose">绘图要求：{workflow.selection.visualPreferences}</p>}</section>
    </aside></div>
    {redrawOpen && <Modal title="告诉我们这次想怎么改" wide onClose={() => { if (busy) cancel(); setRedrawOpen(false); }}>
      <div className="pw-revision"><p>可以只调整视觉，也可以修改产品结构。不设固定问答轮数，信息足够形成完整产品后就直接重画四张预览。</p>
        {workflow.revision && <div className="pw-revision-questions"><p><strong>{workflow.revision.summary}</strong></p>{workflow.revision.questions.map(question => <fieldset key={question.id} disabled={!!busy}><legend>{question.question}</legend>
          {question.options.map(option => <label key={option}><input type="radio" name={`rev-${question.id}`} checked={answers[question.id] === option} onChange={() => setAnswers(current => ({ ...current, [question.id]: option }))} />{option}</label>)}
          <label>自己的答案<input aria-label={`${question.question}：自定义回答`} value={question.options.includes(answers[question.id]) ? '' : answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} maxLength={2000} placeholder="也可以直接说明你希望如何处理" /></label></fieldset>)}</div>}
        <fieldset disabled={!!busy}><legend>重画方向（可多选）</legend><div className="pw-revision-directions">{redrawDirections.map(direction => <label key={direction}><input type="checkbox" checked={directions.includes(direction)} onChange={() => setDirections(current => current.includes(direction) ? current.filter(item => item !== direction) : [...current, direction])} />{direction}</label>)}</div></fieldset>
        <label htmlFor="pw-revision-text">修改说明</label><textarea id="pw-revision-text" data-autofocus rows={4} value={redrawText} onChange={event => setRedrawText(event.target.value)} maxLength={4000} disabled={!!busy} placeholder="例如：保留滑轨和锁定结构，外壳改成圆角，主体用蓝色，并把锁扣结构画得更清楚。" />
        {error && <p className="pw-error" role="alert">{error}</p>}{busy && <p className="pw-muted" role="status">{progress.at(-1)?.detail || '正在理解修改意见…'}</p>}
        <div className="modal-actions"><button className="button secondary" onClick={() => { if (busy) cancel(); setRedrawOpen(false); }}>暂不修改</button>
          <button className="button primary" disabled={!!busy || (!redrawText.trim() && !directions.length && !Object.values(answers).some(text => text.trim())) || !!workflow.revision?.questions.some(question => !answers[question.id]?.trim())} onClick={submitRevision}><Sparkles size={16} />{busy ? '正在分析修改意见…' : workflow.revision ? '提交补充并继续' : '提交修改并重画'}</button></div>
      </div></Modal>}
  </div>;
}
