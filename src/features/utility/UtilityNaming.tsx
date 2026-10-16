import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Lightbulb,
  PencilRuler,
  Sparkles,
} from "lucide-react";
import type { Project } from "../../data";
import {
  checkName,
  countCharacters,
  improvementTypes,
  validateProfile,
} from "./naming";
import type { CompanyProfile, NamingRecord } from "./naming";
import { loadNamingDraftAsync, saveNamingDraft } from "../../storage/projectStorage";
import { storageError as storageErrorMessage } from '../../storage/storageApi';
import { isStructureEvidenceOptions, missingStructureEvidenceCategories, structureEvidenceCategoryLabels } from './structureEvidence';
import type { StructureEvidenceCategory, StructureEvidenceOption } from './structureEvidence';
import { GenerationProgress } from './generationProgress';
import type { ProgressStep } from './generationProgress';
import { progressRequest, withAiRetry } from './progressRequest';
import "./utility.css";
import { ProductProblemNaming } from '../product/ProductProblemNaming';

type ProductOption = { product: string; features: string[] };
const shapeTerms = /形状|外形|轮廓|截面|弧形|曲面|曲线|槽|孔|叶片|齿形|纹路|折叠|弯折/u;
const structureTerms = /连接|支架|壳体|底座|轴|齿轮|铰链|螺栓|螺纹|导轨|限位|定位|安装|固定|配合|组件/u;

function featureRecommendation(features: string[], improvementType?: keyof typeof improvementTypes): Set<string> {
  const ranked = features.map((feature, index) => {
    const shape = shapeTerms.test(feature);
    const structure = structureTerms.test(feature);
    const score = improvementType === 'shape' ? (shape ? 3 : 0) + (structure ? 1 : 0)
      : improvementType === 'structure' ? (structure ? 3 : 0) + (shape ? 1 : 0)
        : (shape ? 2 : 0) + (structure ? 2 : 0);
    return { feature, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return new Set(ranked.slice(0, Math.min(2, features.length)).map(item => item.feature));
}

function improvementRecommendation(features: string[]): { type: keyof typeof improvementTypes; reason: string } {
  const hasShape = features.some(feature => shapeTerms.test(feature));
  const hasStructure = features.some(feature => structureTerms.test(feature));
  if (hasShape && hasStructure) return { type: 'combined', reason: '同时覆盖可辨认形状与部件连接，更利于形成完整产品方案。' };
  if (hasStructure) return { type: 'structure', reason: '当前特征主要体现部件安排、连接或配合，便于明确连接关系。' };
  return { type: 'shape', reason: '当前特征主要体现外形、轮廓或截面，便于明确实际外形。' };
}

function evidenceRecommendation(category: StructureEvidenceCategory): string {
  return {
    component: '先明确实体部件，避免产品方案缺少主体。',
    relationship: '先明确连接或支承，才能明确完整装配关系。',
    motion: '先明确运动或相对固定状态，区分固定、调节和工作状态。',
    geometry: '先明确实际外形和空间关系，便于统一多视图。',
    problem: '可作为结构效果对应的问题线索，辅助完善说明。',
  }[category];
}
// 服务端命名单次调用预算 240 秒；名称生成在修复路径下是两次串行调用（最长约 480 秒），客户端超时必须覆盖该最坏情况。
const NAMING_REQUEST_TIMEOUT_MS = 520_000;

async function postNaming<T>(path: string, body: unknown, onProgress: (step: ProgressStep) => void, signal?: AbortSignal, onRetry?: () => void): Promise<T> {
  try {
    // 限流/超时类错误自动退避重试一次；每次尝试独立 250 秒超时（重试仍失败则按原流程报错）。
    return await withAiRetry((attemptSignal) => progressRequest<T>(path, body, onProgress, attemptSignal).then(result => result.data), {
      signal, attemptTimeoutMs: NAMING_REQUEST_TIMEOUT_MS, onRetry,
    });
  } catch (cause) {
    // 用户主动取消（改输入、切选项、离页面）静默处理，由调用方的版本校验丢弃状态更新。
    if (signal?.aborted) throw cause;
    if ((cause as { code?: unknown })?.code === 'AI_ATTEMPT_TIMEOUT') throw new Error(path.endsWith('/structure-evidence-options') ? '整理结构资料超时，请检查 AI 服务状态后重试。' : '生成超时，请检查 AI 服务状态后重试。');
    throw cause;
  }
}
// 草稿先异步恢复再渲染表单：不用 React use() ——在挂起组件内部创建 promise
// 会导致每次重试都是全新挂载、生成新 promise，无限循环挂起。用显式加载态代替。
export function UtilityNaming({
  project,
  onSave,
  onBack,
  onOpenWorkspace,
  patentType = "utility",
}: {
  project?: Project;
  onSave: (record: NamingRecord) => void;
  onBack: () => void;
  onOpenWorkspace?: () => void;
  patentType?: "utility" | "invention";
}) {
  const [initialDraft, setInitialDraft] = useState<NamingRecord | null>(null);
  const [loadError, setLoadError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadNamingDraftAsync(project?.id, project).then(draft => {
      if (cancelled) return;
      // oxlint-disable-next-line react/set-state-in-effect -- Async draft restore.
      setInitialDraft(draft);
      // Existing feature-based projects retain their original editing form.
      setAdvanced(!draft.problemProposal && !draft.problemSelection && !!(draft.structureSelection || draft.candidates.length || draft.profile.features));
    }).catch(error => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : '命名草稿加载失败。');
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- project identity changes on every save; reload once per id (App remounts on id change via key).
  }, [project?.id]);
  if (!initialDraft) {
    if (loadError) return <div className="empty-state"><p role="alert">{loadError}</p><button className="button secondary" onClick={() => location.reload()}>重新加载</button></div>;
    return (
      <div className="empty-state">
        <h2>正在加载命名草稿…</h2>
      </div>
    );
  }
  if (!advanced) return <ProductProblemNaming initialDraft={initialDraft} project={project} onSave={onSave} onBack={onBack}
    onAdvanced={draft => { setInitialDraft(draft); setAdvanced(true); }} patentType={patentType} />;
  return (
    <><button className="button secondary" onClick={() => setAdvanced(false)}>按技术问题生成</button><UtilityNamingForm
      project={project}
      onSave={onSave}
      onBack={onBack}
      onOpenWorkspace={onOpenWorkspace}
      patentType={patentType}
      initialDraft={initialDraft}
    /></>
  );
}
function UtilityNamingForm({
  project,
  onSave,
  onBack,
  onOpenWorkspace,
  patentType = "utility",
  initialDraft,
}: {
  project?: Project;
  onSave: (record: NamingRecord) => void;
  onBack: () => void;
  onOpenWorkspace?: () => void;
  patentType?: "utility" | "invention";
  initialDraft: NamingRecord;
}) {
  const isInvention = patentType === "invention";
  const [draft, setDraft] = useState<NamingRecord>(initialDraft);
  const [errors, setErrors] = useState<
    Partial<Record<keyof CompanyProfile, string>>
  >({});
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
    field?: keyof CompanyProfile;
  } | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [saved, setSaved] = useState(() => !!project?.naming && JSON.stringify(draft) === JSON.stringify(project.naming));
  const [titleOpen, setTitleOpen] = useState(!!draft.selectedName);
  const [options, setOptions] = useState<ProductOption[]>(() => draft.options || []);
  const [busy, setBusy] = useState<'options' | 'evidence' | 'names' | null>(null);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const requestVersion = useRef(0);
  const namingController = useRef<AbortController | null>(null);
  // 作废中的命名请求：用户改输入、切选项或离开页面时直接断开，避免废弃请求占满服务端并发槽。
  const invalidateRequests = () => {
    namingController.current?.abort();
    namingController.current = null;
    requestVersion.current++;
  };
  const beginRequest = () => {
    namingController.current?.abort();
    const controller = new AbortController();
    namingController.current = controller;
    return { version: ++requestVersion.current, signal: controller.signal };
  };
  useEffect(() => () => { namingController.current?.abort(); }, []);
  const progressFor = (version: number) => (step: ProgressStep) => {
    if (version === requestVersion.current) setProgressSteps(previous => [...previous, step]);
  };
  const resultRef = useRef<HTMLElement>(null);
  const profile = draft.profile;
  const validation = checkName(draft.selectedName, profile);
  const canSave =
    !!draft.selectedName &&
    !validation.errors.length &&
    !!draft.structureSelection?.confirmed &&
    !missingStructureEvidenceCategories(draft.structureSelection).length &&
    !Object.keys(validateProfile(profile)).length;
  // External storage may be unavailable; expose the failure rather than claiming persistence.
  // 防抖：输入每个字符都写一次 IndexedDB 会与项目写入争抢同一 store。
  // 持久化时清除 confirmed：该字段表示「名称已由用户保存确认」，只应随保存动作写入项目记录，
  // 草稿不应携带，避免重新打开页面时被误判为已保存。
  useEffect(() => {
    let cancelled = false;
    const persist = () => {
      saveNamingDraft(project?.id, { ...draft, confirmed: false }).then(ok => {
        // oxlint-disable-next-line react/set-state-in-effect
        if (!cancelled) setStorageError(!ok);
      });
    };
    const timer = setTimeout(persist, 400);
    const flush = () => { clearTimeout(timer); persist(); };
    window.addEventListener('zhichuang:flush-drafts', flush);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener('zhichuang:flush-drafts', flush); };
  }, [draft, project?.id]);
  const update = (key: keyof CompanyProfile, value: string) => {
    invalidateRequests();
    setDraft((d) => ({
      ...d,
      profile: { ...d.profile, ...(key === 'company' || key === 'business' ? { product: '', features: '', improvementType: undefined } : {}), [key]: value },
      options: key === 'company' || key === 'business' ? [] : d.options,
      candidates: [],
      structureOptions: undefined, structureSelection: undefined,
      selectedName: "",
    }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setMessage("");
    setFeedback(null);
    setSaved(false);
    setTitleOpen(false);
    if (key === 'company' || key === 'business') setOptions([]);
    setBusy(null);
  };
  const focusField = (key: keyof CompanyProfile) => {
    const input = document.getElementById(`utility-${key}`);
    const details = input?.closest("details");
    if (details) details.open = true;
    input?.focus();
  };
  const generateOptions = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const problems = validateProfile({ ...profile, product: '', features: '' });
    setErrors(problems);
    setSaved(false);
    setTitleOpen(false);
    setMessage("");
    const firstProblem = (Object.keys(problems) as (keyof CompanyProfile)[])[0];
    if (firstProblem) {
      setFeedback({ kind: "error", text: `尚未生成：${Object.values(problems).join(" ")}`, field: firstProblem });
      focusField(firstProblem);
      return;
    }
    const { version, signal } = beginRequest();
    setBusy('options');
    setProgressSteps([{ label: '提交产品资料', detail: '已校验输入，正在连接生成服务' }]);
    setFeedback(null);
    try {
      const result = await postNaming<{ options: ProductOption[] }>("/api/utility/naming-options", { company: profile.company.trim(), business: profile.business.trim(), excludedTerms: profile.excludedTerms.trim(), previous: options.map(option => option.product) }, progressFor(version), signal,
        () => { if (version === requestVersion.current) setFeedback({ kind: 'success', text: '请求受限，5 秒后自动重试一次…' }); });
      if (version !== requestVersion.current) return;
      setOptions(result.options);
      setDraft(d => ({ ...d, options: result.options, profile: { ...d.profile, product: '', features: '', improvementType: undefined }, candidates: [], selectedName: '', structureOptions: undefined, structureSelection: undefined }));
      setFeedback({ kind: 'success', text: `已生成 ${result.options.length} 组具体产品建议，请核对并选择实际具备的结构特征。` });
    } catch (cause) {
      if (signal.aborted) return;
      if (version === requestVersion.current) setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : '建议生成失败，请重试。' });
    } finally { if (version === requestVersion.current) setBusy(null); }
  };
  const selectOption = (option: ProductOption) => {
    invalidateRequests();
    setDraft(d => ({ ...d, profile: { ...d.profile, product: option.product, features: '', improvementType: undefined }, candidates: [], selectedName: '', structureOptions: undefined, structureSelection: undefined }));
    setMessage(''); setFeedback(null); setSaved(false); setTitleOpen(false);
  };
  const toggleFeature = (feature: string) => {
    invalidateRequests();
    const features = profile.features.split('、').filter(Boolean);
    const next = features.includes(feature) ? features.filter(item => item !== feature) : [...features, feature];
    setDraft(d => ({ ...d, profile: { ...d.profile, features: next.join('、') }, candidates: [], selectedName: '', structureOptions: undefined, structureSelection: undefined }));
    setMessage(''); setFeedback(null); setSaved(false); setTitleOpen(false); setBusy(null);
  };
  const generateEvidence = async () => {
    if (busy) return;
    const problems = validateProfile(profile);
    if (!profile.product || !profile.features || !profile.improvementType || Object.keys(problems).length) {
      setFeedback({ kind: 'error', text: '请先选择保护客体、实际结构特征和改进类型。' }); return;
    }
    const { version, signal } = beginRequest();
    setBusy('evidence'); setFeedback(null);
    setProgressSteps([{ label: '提交结构输入', detail: '正在连接生成服务' }]);
    setDraft(d => ({ ...d, structureOptions: undefined, structureSelection: undefined, candidates: [], selectedName: '' }));
    try {
      const result = await postNaming<{ options: StructureEvidenceOption[] }>('/api/utility/structure-evidence-options', { profile }, progressFor(version), signal,
        () => { if (version === requestVersion.current) setFeedback({ kind: 'success', text: '请求受限，5 秒后自动重试一次…' }); });
      if (version !== requestVersion.current) return;
      if (!isStructureEvidenceOptions(result.options, ['component', 'relationship', 'motion', 'geometry', 'problem'])) throw new Error('结构资料选项不完整，请重新生成。');
      setDraft(d => ({ ...d, structureOptions: result.options, structureSelection: { version: 1, options: result.options, selectedIds: [], confirmed: false }, candidates: [], selectedName: '' }));
      setSaved(false); setTitleOpen(false);
      setFeedback({ kind: 'success', text: '请逐项核对结构资料，仅勾选实际具备的内容，完成后点击“下一步”。' });
    } catch (cause) {
      if (signal.aborted) return;
      if (version === requestVersion.current) setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : '结构资料生成失败，请重试。' });
    } finally { if (version === requestVersion.current) setBusy(null); }
  };
  const toggleEvidence = (id: string) => {
    setDraft(d => ({ ...d, structureSelection: d.structureSelection ? {
      ...d.structureSelection, selectedIds: d.structureSelection.selectedIds.includes(id) ? d.structureSelection.selectedIds.filter(value => value !== id) : [...d.structureSelection.selectedIds, id], confirmed: false,
    } : undefined, candidates: [], selectedName: '' }));
    setSaved(false); setTitleOpen(false);
  };
  const generateNames = async () => {
    if (busy) return;
    if (!draft.structureSelection || missingStructureEvidenceCategories(draft.structureSelection).length) { setFeedback({ kind: 'error', text: '请先选择产品结构、连接、运动和外形空间资料。' }); return; }
    if (!profile.product.trim() || !profile.features.trim() || !profile.improvementType) { setFeedback({ kind: 'error', text: '请先选择保护客体、改进类型，并至少勾选一项实际结构特征。' }); return; }
    const problems = validateProfile(profile);
    setErrors(problems);
    if (Object.keys(problems).length) { setFeedback({ kind: 'error', text: Object.values(problems).join(' ') }); return; }
    const structureEvidence = { ...draft.structureSelection, confirmed: true };
    setDraft(d => ({ ...d, structureSelection: structureEvidence }));
    const { version, signal } = beginRequest();
    setBusy('names'); setFeedback(null); setMessage('');
    setProgressSteps([{ label: '提交已确认资料', detail: '正在连接生成服务' }]);
    try {
      const result = await postNaming<{ candidates: NamingRecord['candidates'] }>("/api/utility/naming-names", { profile, structureEvidence, previous: draft.candidates.map(item => item.name) }, progressFor(version), signal,
        () => { if (version === requestVersion.current) setFeedback({ kind: 'success', text: '请求受限，5 秒后自动重试一次…' }); });
      if (version !== requestVersion.current) return;
      setDraft(d => ({ ...d, candidates: result.candidates, selectedName: '' }));
      setTitleOpen(false); setSaved(false);
      setFeedback({ kind: 'success', text: `已生成 ${result.candidates.length} 个名称候选，请选择并确认。` });
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (cause) {
      if (signal.aborted) return;
      if (version === requestVersion.current) setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : '名称生成失败，请重试。' });
    } finally { if (version === requestVersion.current) setBusy(null); }
  };
  const fieldError = (key: keyof CompanyProfile) =>
    errors[key] && (
      <p className="un-error" id={`utility-${key}-error`} role="alert">
        {errors[key]}
      </p>
    );
  return (
      <div className="utility-naming" data-patent-type={patentType}>
      <button className="un-back" onClick={onBack}>
        <ArrowLeft size={16} />
        返回工作台
      </button>
      <header className="un-heading">
        <div>
          <div className="un-eyebrow">{isInvention ? "INVENTION PATENT · 发明专利" : "UTILITY MODEL · 实用新型专利"}</div>
          <h1>{isInvention ? "好发明，从一个准确的技术主题开始" : "好专利，从一个准确的名字开始"}</h1>
          <p>{isInvention ? "从企业业务和真实技术资料出发，形成可核对的技术方案。" : "从企业业务出发，找到清晰、客观的产品技术主题。"}</p>
        </div>
      </header>
      <ol className="un-steps" aria-label={`${isInvention ? "发明专利" : "实用新型"}创作步骤`}>
        <li aria-current="step">
          <span className="un-step-icon">
            <Lightbulb size={21} />
          </span>
          <div>
            <small>STEP 01 · 当前步骤</small>
            <strong>取名字</strong>
            <p>明确产品与保护主题</p>
          </div>
          <ArrowRight className="un-step-arrow" size={18} />
        </li>
        <li aria-disabled="true">
          <span className="un-step-icon">
            <PencilRuler size={21} />
          </span>
          <div>
            <small>STEP 02 · 下一步</small>
            <strong>逻辑校验与简介</strong>
            <p>检查选择矛盾并生成详细产品简介</p>
          </div>
          <ArrowRight className="un-step-arrow" size={18} />
        </li>
        <li>
          <span className="un-step-icon">
            <PencilRuler size={21} />
          </span>
          <div>
            <small>STEP 03</small>
            <strong>彩色预览</strong>
            <p>生成三视图，可不限次数重画</p>
          </div>
          <ArrowRight className="un-step-arrow" size={18} />
        </li>
        <li>
          <span className="un-step-icon"><FileText size={21} /></span>
          <div><small>STEP 04</small><strong>文档成品</strong><p>确认后生成文案和黑白附图</p></div>
        </li>
      </ol>
      <div className="un-layout">
        <section
          className="un-panel un-company"
          aria-labelledby="company-heading"
        >
          <div className="un-panel-heading">
            <span className="un-number">01</span>
            <div>
              <h2 id="company-heading">先了解你的企业</h2>
            </div>
          </div>
          <form onSubmit={(event) => void generateOptions(event)} noValidate>
            <label htmlFor="utility-company">
              企业名称 <span className="required">*</span>
            </label>
            <input
              id="utility-company"
              value={profile.company}
              onChange={(e) => update("company", e.target.value)}
              maxLength={100}
              placeholder="请输入企业全称"
              required
              aria-invalid={!!errors.company}
              aria-describedby={
                errors.company ? "utility-company-error" : undefined
              }
            />
            {fieldError("company")}
            <label htmlFor="utility-business">
              产品名称 <span className="required">*</span>
            </label>
            <input
              id="utility-business"
              value={profile.business}
              onChange={(e) => update("business", e.target.value)}
              maxLength={1000}
              placeholder="例如：钢材、光伏组件安装支架"
              required
              aria-invalid={!!errors.business}
              aria-describedby={
                errors.business ? "utility-business-error" : undefined
              }
            />
            {fieldError("business")}
            <details className="un-advanced">
              <summary>
                排除品牌、人名及型号
                <ChevronDown size={15} />
              </summary>
              <label htmlFor="utility-excludedTerms">
                不应出现在名称中的词 <span className="un-optional">选填</span>
              </label>
              <input
                id="utility-excludedTerms"
                value={profile.excludedTerms}
                onChange={(e) => update("excludedTerms", e.target.value)}
                maxLength={200}
                aria-invalid={!!errors.excludedTerms}
                aria-describedby={errors.excludedTerms ? "utility-excludedTerms-error" : undefined}
                placeholder="品牌、姓名或型号，用逗号分隔"
              />
              {fieldError("excludedTerms")}
              <p className="un-hint">
                规则无法识别所有商标和人名，请主动补充并人工复核。
              </p>
            </details>
            <button type="submit" className="button primary un-generate" disabled={!!busy} aria-busy={busy === 'options'}>
              <Sparkles size={17} />
              {busy === 'options' ? '正在生成产品建议…' : options.length ? '换一批产品建议' : '生成产品建议'}
              <ArrowRight size={16} />
              {busy === 'options' && <span className="un-button-progress" role="progressbar" aria-label="产品建议生成进度" aria-valuetext="正在生成" />}
            </button>
            {busy === 'options' && <GenerationProgress title="正在生成产品建议" label="产品建议详细进度" steps={progressSteps} next="呈现具体产品建议" note="模型建议需按实际产品核对。" testId="options-progress" />}
            {options.length > 0 && <div className="un-options" role="group" aria-label="核心产品与结构建议">
              <div className="un-divider"><span>具体产品 / 保护客体 · 选择一项</span></div>
              {options.map((option, index) => <button type="button" key={option.product} className={`un-option ${profile.product === option.product ? 'selected' : ''}`} aria-label={option.product} aria-pressed={profile.product === option.product} onClick={() => selectOption(option)} disabled={!!busy}>
                <span><span>{option.product}</span>{index === 0 && <small className="un-recommendation"><Lightbulb size={13} />推荐：更适合继续生成结构</small>}</span>{profile.product === option.product && <Check size={16} />}
              </button>)}
              {profile.product && <fieldset className="un-feature-fieldset"><legend>实际结构特征 · 可多选</legend>
                {(() => { const features = options.find(option => option.product === profile.product)?.features || []; const recommended = featureRecommendation(features, profile.improvementType); return features.map(feature => <label key={feature} className="un-feature"><input type="checkbox" checked={profile.features.split('、').includes(feature)} onChange={() => toggleFeature(feature)} disabled={!!busy} /><span>{feature}{recommended.has(feature) && <small className="un-recommendation"><Lightbulb size={13} />建议优先核对：有助于建立模型关键部件或连接</small>}</span></label>); })()}
                <p className="un-hint">请只选择产品实际具备的结构；推荐项仅表示更利于生成结构模型，仍需按实物或图纸核对。</p>
              </fieldset>}
              {profile.product && <fieldset className="un-feature-fieldset"><legend>改进类型 · 选择一项</legend>
                {(() => { const recommended = improvementRecommendation(profile.features.split('、').filter(Boolean)); return (Object.entries(improvementTypes) as [keyof typeof improvementTypes, string][]).map(([type, label]) => <label key={type} className="un-feature"><input type="radio" name="improvement-type" checked={profile.improvementType === type} onChange={() => { invalidateRequests(); setDraft(d => ({ ...d, profile: { ...d.profile, improvementType: type }, candidates: [], selectedName: '', structureOptions: undefined, structureSelection: undefined })); setBusy(null); setSaved(false); setTitleOpen(false); }} disabled={!!busy} /><span>{label}{recommended.type === type && <small className="un-recommendation"><Lightbulb size={13} />推荐：{recommended.reason}</small>}</span></label>); })()}
                <p className="un-hint">形状对应可辨认的外形或截面；构造对应部件安排与连接；结合须两者共同作用。推荐不替代对实物或图纸的确认。</p>
              </fieldset>}
              {!!draft.structureOptions?.length && <fieldset className="un-evidence-fieldset"><legend>结构资料 · 选择实际具备的内容</legend>
                {(Object.keys(structureEvidenceCategoryLabels) as StructureEvidenceCategory[]).map(category => <div key={category} className="un-evidence-group"><strong>{structureEvidenceCategoryLabels[category]}</strong>
                  {draft.structureOptions!.filter(option => option.category === category).map((option, index) => <label key={option.id} className="un-feature"><input type="checkbox" checked={!!draft.structureSelection?.selectedIds.includes(option.id)} onChange={() => toggleEvidence(option.id)} disabled={!!busy} /><span><b>{option.label}</b>{index === 0 && <small className="un-recommendation"><Lightbulb size={13} />建议优先核对：{evidenceRecommendation(category)}</small>}<small>{option.detail}</small></span></label>)}
                </div>)}
                {draft.structureSelection?.confirmed && <p role="status">已确认 {draft.structureSelection.selectedIds.length} 项结构资料</p>}
                {!!missingStructureEvidenceCategories(draft.structureSelection).length && <p className="un-hint">尚需确认：{missingStructureEvidenceCategories(draft.structureSelection).map(category => structureEvidenceCategoryLabels[category]).join('、')}</p>}
              </fieldset>}
              <div className="un-structure-actions">
                <button type="button" className="button primary un-generate" disabled={!profile.product || !profile.features || !profile.improvementType || !!busy || (!!draft.structureOptions?.length && !!missingStructureEvidenceCategories(draft.structureSelection).length)} aria-busy={busy === 'evidence' || busy === 'names'} onClick={() => void (draft.structureOptions?.length ? generateNames() : generateEvidence())}>
                  <Sparkles size={17} />{busy === 'evidence' ? '正在整理结构资料…' : busy === 'names' ? '正在生成名称…' : '下一步'}<ArrowRight size={16} />
                  {busy === 'names' && <span className="un-button-progress" role="progressbar" aria-label="名称生成进度" aria-valuetext="正在生成" />}
                </button>
              </div>
              {busy === 'evidence' && <GenerationProgress title="正在整理结构资料" label="结构资料生成进度" steps={progressSteps} next="呈现待核对选项" note="选项仅供核对，尚不是已确认事实。" testId="evidence-progress" />}
              {busy === 'names' && <GenerationProgress title="正在生成产品名称" label="名称详细进度" steps={progressSteps} next="呈现名称候选" testId="names-progress" />}
            </div>}
            {feedback && (
              <div className={`un-action-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
                <p>{feedback.text}</p>
                {feedback.field ? (
                  <button type="button" className="un-feedback-link" onClick={() => focusField(feedback.field!)}>
                    前往补充或修改信息 <ArrowRight size={14} />
                  </button>
                ) : feedback.kind === "success" ? (
                  <button type="button" className="un-feedback-link" onClick={() => resultRef.current?.focus()}>
                    查看名称候选 <ArrowRight size={14} />
                  </button>
                ) : null}
              </div>
            )}
            {storageError && (
              <p className="un-error" role="alert">
                {storageErrorMessage()} 请及时复制名称。
              </p>
            )}
          </form>
        </section>
        <div className="un-right">
          <section
            className="un-panel un-results"
            ref={resultRef}
            tabIndex={-1}
            aria-labelledby="results-heading"
          >
            <div className="un-panel-heading">
              <span className="un-number">02</span>
              <div>
                <h2 id="results-heading">为产品找到准确的名字</h2>
                <p>选择一个方向，再结合真实技术方案确认</p>
              </div>
              {draft.candidates.length > 0 && (
                <span className="un-count">
                  {draft.candidates.length} 个候选
                </span>
              )}
            </div>
            <div className="un-result-status" role="status">
              {draft.candidates.length
                ? "候选已生成。仅做关键词与格式检查，不代表符合全部审查要求。"
                : options.length ? "确认真实的保护客体与结构特征后，生成名称。" : "填写企业与产品名称，生成产品建议。"}
            </div>
            {message && !draft.candidates.length ? (
              <div className="un-empty un-generation-error">
                <CircleAlert size={32} aria-hidden="true" />
                <h3>暂时没有可用的名称候选</h3>
                <p>请调整产品名称或已选的结构特征后重试。</p>
                <button type="button" className="button secondary" onClick={() => document.querySelector<HTMLButtonElement>(".un-generate")?.focus()}>
                  返回生成按钮重试
                </button>
              </div>
            ) : !draft.candidates.length && !draft.selectedName ? (
              <div className="un-empty">
                <span className="un-empty-icon">
                  <Box size={35} />
                  <span>
                    <Lightbulb size={18} />
                  </span>
                </span>
                <h3>让名称，准确表达你的技术</h3>
                <div className="un-formula">
                  <span>一种</span>
                  <b>＋</b>
                  <span>结构限定</span>
                  <b>＋</b>
                  <span>核心产品</span>
                </div>
                <small>例如：一种带角度调节结构的光伏组件安装支架</small>
              </div>
            ) : (
              <div className="un-candidates" role="group" aria-label="名称候选">
                {draft.candidates.map((candidate, index) => (
                  <button
                    type="button"
                    key={candidate.name}
                    aria-pressed={draft.selectedName === candidate.name}
                    className={`un-candidate ${draft.selectedName === candidate.name ? "selected" : ""}`}
                    onClick={() => {
                      setDraft((d) => ({
                        ...d,
                        selectedName: candidate.name,
                      }));
                      setSaved(false);
                      setTitleOpen(true);
                    }}
                  >
                    <span className="un-candidate-top">
                      <span className="un-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="un-candidate-name"><strong>{candidate.name}</strong>{index === 0 && <small className="un-recommendation"><Lightbulb size={13} />推荐：结构限定清晰，便于继续生成 Patent Structure Model</small>}</span>
                      <span className="un-radio">
                        {draft.selectedName === candidate.name && (
                          <Check size={12} />
                        )}
                      </span>
                    </span>
                    <span className="un-candidate-meta">
                      {countCharacters(candidate.name)} 字 ·{" "}
                      {candidate.inferred ? "方向建议 · 技术待确认" : "基于已选结构特征"}
                    </span>
                    <span className="un-candidate-basis">
                      {candidate.basis} · 核心客体：{candidate.product}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {titleOpen && (
              <div className="un-name-confirm">
                <input
                  id="utility-title"
                  aria-label={isInvention ? "发明专利名称" : "实用新型名称"}
                  value={draft.selectedName}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, selectedName: e.target.value }));
                    setSaved(false);
                  }}
                  aria-invalid={!!validation.errors.length}
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={!canSave || !!busy || (saved && !onOpenWorkspace)}
                  onClick={() => {
                    if (!canSave || busy) return;
                    if (saved) { onOpenWorkspace?.(); return; }
                    onSave({ ...draft, confirmed: true });
                    setSaved(true);
                  }}
                >
                  <Check size={16} />
                  {saved ? "进入产品预览与材料工作区" : "确认名称并检查产品逻辑"}
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
