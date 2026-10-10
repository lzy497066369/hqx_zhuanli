import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Copy,
  FileText,
  Lightbulb,
  PencilRuler,
  RotateCcw,
  ShieldCheck,
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
import { isStructureEvidenceOptions, missingStructureEvidenceCategories, structureEvidenceCategoryLabels } from './structureEvidence';
import type { StructureEvidenceCategory, StructureEvidenceOption } from './structureEvidence';
import { GenerationProgress } from './generationProgress';
import type { ProgressStep } from './generationProgress';
import { progressRequest, withAiRetry } from './progressRequest';
import "./utility.css";

const example: CompanyProfile = {
  company: "示例光伏设备有限公司",
  business: "光伏组件安装支架",
  product: "",
  features: "",
  excludedTerms: "",
};
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
  if (hasShape && hasStructure) return { type: 'combined', reason: '同时覆盖可辨认形状与部件连接，更利于形成完整结构模型。' };
  if (hasStructure) return { type: 'structure', reason: '当前特征主要体现部件安排、连接或配合，便于建立结构关系。' };
  return { type: 'shape', reason: '当前特征主要体现外形、轮廓或截面，便于表达实体几何。' };
}

function evidenceRecommendation(category: StructureEvidenceCategory): string {
  return {
    component: '先明确实体部件，避免结构模型缺少主体。',
    relationship: '先明确连接或支承，模型才能建立连通关系。',
    motion: '先明确运动或相对固定状态，避免误判运动关系。',
    geometry: '先选择可表达的外形，便于生成结构几何。',
    problem: '可作为结构效果对应的问题线索，辅助完善说明。',
  }[category];
}
// 服务端命名单次调用预算 120 秒；名称生成在修复路径下是两次串行调用（最长约 240 秒），客户端超时必须覆盖该最坏情况。
const NAMING_REQUEST_TIMEOUT_MS = 250_000;

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
  useEffect(() => {
    let cancelled = false;
    loadNamingDraftAsync(project?.id, project).then(draft => {
      if (cancelled) return;
      // oxlint-disable-next-line react/set-state-in-effect -- Async draft restore.
      setInitialDraft(draft);
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- project identity changes on every save; reload once per id (App remounts on id change via key).
  }, [project?.id]);
  if (!initialDraft) {
    return (
      <div className="empty-state">
        <h2>正在加载命名草稿…</h2>
      </div>
    );
  }
  return (
    <UtilityNamingForm
      project={project}
      onSave={onSave}
      onBack={onBack}
      onOpenWorkspace={onOpenWorkspace}
      patentType={patentType}
      initialDraft={initialDraft}
    />
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
  const [notice, setNotice] = useState("");
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
  const selected = draft.candidates.find((c) => c.name === draft.selectedName);
  const canSave =
    !!draft.selectedName &&
    !validation.errors.length &&
    draft.confirmed &&
    !!draft.structureSelection?.confirmed &&
    !missingStructureEvidenceCategories(draft.structureSelection).length &&
    !Object.keys(validateProfile(profile)).length;
  // External storage may be unavailable; expose the failure rather than claiming persistence.
  // 防抖：输入每个字符都写一次 IndexedDB 会与项目写入争抢同一 store。
  // 持久化时清除 confirmed：确认是「本次保存动作」的前提，不该被草稿自动落库预置，
  // 否则重新打开页面时进入工作区的门禁条件已被满足。
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      saveNamingDraft(project?.id, { ...draft, confirmed: false }).then(ok => {
        // oxlint-disable-next-line react/set-state-in-effect
        if (!cancelled) setStorageError(!ok);
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft, project?.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const update = (key: keyof CompanyProfile, value: string) => {
    invalidateRequests();
    setDraft((d) => ({
      ...d,
      profile: { ...d.profile, ...(key === 'company' || key === 'business' ? { product: '', features: '', improvementType: undefined } : {}), [key]: value },
      options: key === 'company' || key === 'business' ? [] : d.options,
      candidates: [],
      structureOptions: undefined, structureSelection: undefined,
      selectedName: "",
      confirmed: false,
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
      setDraft(d => ({ ...d, options: result.options, profile: { ...d.profile, product: '', features: '', improvementType: undefined }, candidates: [], selectedName: '', confirmed: false, structureOptions: undefined, structureSelection: undefined }));
      setFeedback({ kind: 'success', text: `已生成 ${result.options.length} 组具体产品建议，请核对并选择实际具备的结构特征。` });
    } catch (cause) {
      if (signal.aborted) return;
      if (version === requestVersion.current) setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : '建议生成失败，请重试。' });
    } finally { if (version === requestVersion.current) setBusy(null); }
  };
  const selectOption = (option: ProductOption) => {
    invalidateRequests();
    setDraft(d => ({ ...d, profile: { ...d.profile, product: option.product, features: '', improvementType: undefined }, candidates: [], selectedName: '', confirmed: false, structureOptions: undefined, structureSelection: undefined }));
    setMessage(''); setFeedback(null); setSaved(false); setTitleOpen(false);
  };
  const toggleFeature = (feature: string) => {
    invalidateRequests();
    const features = profile.features.split('、').filter(Boolean);
    const next = features.includes(feature) ? features.filter(item => item !== feature) : [...features, feature];
    setDraft(d => ({ ...d, profile: { ...d.profile, features: next.join('、') }, candidates: [], selectedName: '', confirmed: false, structureOptions: undefined, structureSelection: undefined }));
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
    setDraft(d => ({ ...d, structureOptions: undefined, structureSelection: undefined, candidates: [], selectedName: '', confirmed: false }));
    try {
      const result = await postNaming<{ options: StructureEvidenceOption[] }>('/api/utility/structure-evidence-options', { profile }, progressFor(version), signal,
        () => { if (version === requestVersion.current) setFeedback({ kind: 'success', text: '请求受限，5 秒后自动重试一次…' }); });
      if (version !== requestVersion.current) return;
      if (!isStructureEvidenceOptions(result.options, ['component', 'relationship', 'motion', 'geometry', 'problem'])) throw new Error('结构资料选项不完整，请重新生成。');
      setDraft(d => ({ ...d, structureOptions: result.options, structureSelection: { version: 1, options: result.options, selectedIds: [], confirmed: false }, candidates: [], selectedName: '', confirmed: false }));
      setSaved(false); setTitleOpen(false);
      setFeedback({ kind: 'success', text: '请逐项核对结构资料，仅勾选实际具备的内容。' });
    } catch (cause) {
      if (signal.aborted) return;
      if (version === requestVersion.current) setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : '结构资料生成失败，请重试。' });
    } finally { if (version === requestVersion.current) setBusy(null); }
  };
  const toggleEvidence = (id: string) => {
    setDraft(d => ({ ...d, structureSelection: d.structureSelection ? {
      ...d.structureSelection, selectedIds: d.structureSelection.selectedIds.includes(id) ? d.structureSelection.selectedIds.filter(value => value !== id) : [...d.structureSelection.selectedIds, id], confirmed: false,
    } : undefined, candidates: [], selectedName: '', confirmed: false }));
    setSaved(false); setTitleOpen(false);
  };
  const generateNames = async () => {
    if (busy) return;
    if (!draft.structureSelection?.confirmed || missingStructureEvidenceCategories(draft.structureSelection).length) { setFeedback({ kind: 'error', text: '请先选择并确认产品结构、连接、运动和可表达几何资料。' }); return; }
    if (!profile.product.trim() || !profile.features.trim() || !profile.improvementType) { setFeedback({ kind: 'error', text: '请先选择保护客体、改进类型，并至少勾选一项实际结构特征。' }); return; }
    const problems = validateProfile(profile);
    setErrors(problems);
    if (Object.keys(problems).length) { setFeedback({ kind: 'error', text: Object.values(problems).join(' ') }); return; }
    const { version, signal } = beginRequest();
    setBusy('names'); setFeedback(null); setMessage('');
    setProgressSteps([{ label: '提交已确认资料', detail: '正在连接生成服务' }]);
    try {
      const result = await postNaming<{ candidates: NamingRecord['candidates'] }>("/api/utility/naming-names", { profile, structureEvidence: draft.structureSelection, previous: draft.candidates.map(item => item.name) }, progressFor(version), signal,
        () => { if (version === requestVersion.current) setFeedback({ kind: 'success', text: '请求受限，5 秒后自动重试一次…' }); });
      if (version !== requestVersion.current) return;
      setDraft(d => ({ ...d, candidates: result.candidates, selectedName: '', confirmed: false }));
      setTitleOpen(false); setSaved(false);
      setFeedback({ kind: 'success', text: `已生成 ${result.candidates.length} 个名称候选，请选择并确认。` });
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (cause) {
      if (signal.aborted) return;
      if (version === requestVersion.current) setFeedback({ kind: 'error', text: cause instanceof Error ? cause.message : '名称生成失败，请重试。' });
    } finally { if (version === requestVersion.current) setBusy(null); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.selectedName);
      setNotice("名称已复制");
    } catch {
      setNotice("无法访问剪贴板，请在名称输入框中手动选择并复制。");
    }
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
        <span className="un-mode"><Sparkles size={15} />AI 选题 · 规则复核</span>
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
            <strong>确认结构</strong>
            <p>根据名称生成并编译结构模型</p>
          </div>
          <ArrowRight className="un-step-arrow" size={18} />
        </li>
        <li>
          <span className="un-step-icon">
            <PencilRuler size={21} />
          </span>
          <div>
            <small>STEP 03</small>
            <strong>绘图与部件</strong>
            <p>按模型生成附图和标记</p>
          </div>
          <ArrowRight className="un-step-arrow" size={18} />
        </li>
        <li>
          <span className="un-step-icon"><FileText size={21} /></span>
          <div><small>STEP 04</small><strong>申请材料</strong><p>按模型生成并核对文案</p></div>
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
              <p>信息越具体，名称越贴近实际产品</p>
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
                errors.company ? "utility-company-error" : "company-hint"
              }
            />
            {fieldError("company")}
            <p className="un-hint" id="company-hint">
              仅用于项目归属，不会拼入专利名称。
            </p>
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
                {(() => { const recommended = improvementRecommendation(profile.features.split('、').filter(Boolean)); return (Object.entries(improvementTypes) as [keyof typeof improvementTypes, string][]).map(([type, label]) => <label key={type} className="un-feature"><input type="radio" name="improvement-type" checked={profile.improvementType === type} onChange={() => { invalidateRequests(); setDraft(d => ({ ...d, profile: { ...d.profile, improvementType: type }, candidates: [], selectedName: '', confirmed: false, structureOptions: undefined, structureSelection: undefined })); setBusy(null); setSaved(false); setTitleOpen(false); }} disabled={!!busy} /><span>{label}{recommended.type === type && <small className="un-recommendation"><Lightbulb size={13} />推荐：{recommended.reason}</small>}</span></label>); })()}
                <p className="un-hint">形状对应可辨认的外形或截面；构造对应部件安排与连接；结合须两者共同作用。推荐不替代对实物或图纸的确认。</p>
              </fieldset>}
              {!!draft.structureOptions?.length && <fieldset className="un-evidence-fieldset"><legend>结构资料 · 选择实际具备的内容</legend>
                {(Object.keys(structureEvidenceCategoryLabels) as StructureEvidenceCategory[]).map(category => <div key={category} className="un-evidence-group"><strong>{structureEvidenceCategoryLabels[category]}</strong>
                  {draft.structureOptions!.filter(option => option.category === category).map((option, index) => <label key={option.id} className="un-feature"><input type="checkbox" checked={!!draft.structureSelection?.selectedIds.includes(option.id)} onChange={() => toggleEvidence(option.id)} disabled={!!busy} /><span><b>{option.label}</b>{index === 0 && <small className="un-recommendation"><Lightbulb size={13} />建议优先核对：{evidenceRecommendation(category)}</small>}<small>{option.detail}</small></span></label>)}
                </div>)}
                <button type="button" className="button secondary" disabled={!!busy || !draft.structureSelection?.selectedIds.length || !!missingStructureEvidenceCategories(draft.structureSelection).length} onClick={() => { setDraft(d => ({ ...d, structureSelection: d.structureSelection ? { ...d.structureSelection, confirmed: true } : undefined })); setFeedback({ kind: 'success', text: '结构资料已确认，可以生成名称。' }); }}>确认所选结构资料</button>
                {draft.structureSelection?.confirmed && <p role="status">已确认 {draft.structureSelection.selectedIds.length} 项结构资料</p>}
                {!!missingStructureEvidenceCategories(draft.structureSelection).length && <p className="un-hint">尚需确认：{missingStructureEvidenceCategories(draft.structureSelection).map(category => structureEvidenceCategoryLabels[category]).join('、')}</p>}
              </fieldset>}
              <div className="un-structure-actions">
                <button type="button" className="button secondary un-generate" disabled={!profile.product || !profile.features || !profile.improvementType || !!busy} aria-busy={busy === 'evidence'} onClick={() => void generateEvidence()}>
                  <Sparkles size={17} />{busy === 'evidence' ? '正在整理结构资料…' : draft.structureOptions?.length ? '重新整理结构资料' : '生成结构资料选项'}
                </button>
                <button type="button" className="button primary un-generate" disabled={!draft.structureSelection?.confirmed || !!busy} aria-busy={busy === 'names'} onClick={() => void generateNames()}>
                  <Sparkles size={17} />{busy === 'names' ? '正在生成名称…' : draft.candidates.length ? '换一批名称' : '确认选项并生成名称'}<ArrowRight size={16} />
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
            <button
              type="button"
              className="un-example"
              onClick={() => {
                if (
                  (profile.company ||
                    profile.business ||
                    profile.product ||
                    draft.selectedName) &&
                  !window.confirm("加载示例将替换当前命名草稿，是否继续？")
                )
                  return;
                invalidateRequests();
                setOptions([]); setBusy(null);
                setDraft({
                  version: 1,
                  profile: example,
                  options: [],
                  candidates: [],
                  selectedName: "",
                  confirmed: false,
                });
                setErrors({});
                setMessage("");
                setFeedback(null);
                setTitleOpen(false);
                setSaved(false);
              }}
            >
              <RotateCcw size={13} />
              试填一份光伏企业示例
            </button>
            <p className="un-privacy">
              <ShieldCheck size={13} />
              {storageError
                ? "浏览器存储不可用，请及时复制名称。"
                : "草稿保存在此浏览器；生成建议时会向 AI 服务发送企业与产品信息。"}
            </p>
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
                <p>
                  产品名称提供方向，实际结构决定主题。
                  <br />
                  不堆砌效果词，不编造创新点。
                </p>
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
                        confirmed: false,
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
            <div className="un-disclaimer">
              <CircleAlert size={15} />
              <p>
                AI 建议不等于已核实的技术方案。系统不判断新颖性或可授权性；请选择产品实际具备的结构。
              </p>
            </div>
          </section>
          {titleOpen && (
            <section
              className="un-panel un-confirm"
              aria-labelledby="confirm-heading"
            >
              <div className="un-panel-heading">
                <span className="un-number">03</span>
                <div>
                  <h2 id="confirm-heading">确认本次名称</h2>
                  <p>可直接修改，规则检查会同步更新</p>
                </div>
                <button
                  className="icon-button"
                  aria-label="复制选中名称"
                  onClick={copy}
                >
                  <Copy size={18} />
                </button>
              </div>
              <label htmlFor="utility-title">{isInvention ? "发明专利名称" : "实用新型名称"}</label>
              <input
                id="utility-title"
                value={draft.selectedName}
                onChange={(e) => {
                  setDraft((d) => ({
                    ...d,
                    selectedName: e.target.value,
                    confirmed: false,
                  }));
                  setSaved(false);
                }}
                aria-describedby="title-validation"
                aria-invalid={!!validation.errors.length}
              />
              <div id="title-validation" aria-live="polite">
                <p className="un-title-count">
                  {validation.length} 字 / 本系统上限 40 字
                </p>
                {validation.errors.map((e) => (
                  <p className="un-error" key={e}>
                    <CircleAlert size={14} />
                    {e}
                  </p>
                ))}
                {validation.warnings.map((w) => (
                  <p className="un-warning" key={w}>
                    {w}
                  </p>
                ))}
                {!validation.errors.length && (
                  <p className="un-pass">
                    <CheckCheck size={15} />
                    基础规则检查未发现阻断项，仍需人工复核。
                  </p>
                )}
              </div>
              {selected && (
                <p className="un-hint">
                  保护客体：{selected.product} · {profile.improvementType ? `${improvementTypes[profile.improvementType]} · ` : ''}结构限定：{selected.feature}
                </p>
              )}
              <label className="un-confirm-check">
                <input
                  type="checkbox"
                  checked={draft.confirmed}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, confirmed: e.target.checked }));
                    setSaved(false);
                  }}
                />
                <span>
                  我已确认名称与真实产品的形状、构造或连接关系一致，不含品牌、人名、型号或宣传用语；其中的建议特征确实存在。
                </span>
              </label>
              <div className="un-save-row">
                <span>
                  {saved
                    ? "名称已保存，可在项目管理中查看"
                    : "保存后仍可返回修改"}
                </span>
                <button
                  className="button primary"
                  disabled={!canSave || saved}
                  onClick={() => {
                    if (!canSave) return;
                    onSave(draft);
                    setSaved(true);
                  }}
                >
                  <Check size={16} />
                  {saved ? "已保存名称" : "确认名称并保存"}
                </button>
                {(saved || (project && draft.selectedName === project.name && draft.confirmed)) && onOpenWorkspace && (
                  <button className="button secondary" onClick={onOpenWorkspace}>
                    <PencilRuler size={16} />
                    进入结构与材料工作区
                  </button>
                )}
              </div>
              <p className="un-hint">
                保存名称后，按名称生成结构、附图和申请材料初稿。
              </p>
            </section>
          )}
          <section className="un-rules" aria-labelledby="rules-heading">
            <h2 id="rules-heading">
              <BookOpen size={17} />
              命名的四个关键词
            </h2>
            <div className="un-rule-grid">
              <div>
                <strong>清楚</strong>
                <p>
                  写明产品客体
                  <br />
                  不只写“装置”
                </p>
              </div>
              <div>
                <strong>客观</strong>
                <p>
                  不带宣传色彩
                  <br />
                  不含品牌型号
                </p>
              </div>
              <div>
                <strong>准确</strong>
                <p>
                  围绕实际构造
                  <br />
                  不替代技术方案
                </p>
              </div>
              <div>
                <strong>简洁</strong>
                <p>
                  建议 15–25 字<br />
                  删除多余修饰
                </p>
              </div>
            </div>
            <details>
              <summary>
                查看命名规则与使用边界
                <ChevronDown size={15} />
              </summary>
              <ul>
                <li>
                  名称应清楚、简要地表明技术主题，采用本技术领域通用术语。
                </li>
                <li>
                  《专利审查指南》通常要求名称不超过 25
                  字，必要时可放宽但不得超过 60 字。本系统按业务要求采用建议
                  15–25 字、最多 40 字；不足 15 字仅提示。
                </li>
                <li>
                  “一种”是本系统的模板偏好，不是法定必需前缀。“新型、高效、节能、低阻力”等按本项目严格规则拦截，不将技术效果当成结构特征。
                </li>
                <li>
                  以明确的产品客体为重心，优先描述形状、构造及连接关系。系统仅进行词库辅助检查，不能穷举商标、人名、型号或判断技术真实性。
                </li>
                <li>
                  AI 推荐的保护客体及结构特征需由你核对真实性；名称仍须通过本地规则检查。
                </li>
              </ul>
              <a
                href="https://www.cnipa.gov.cn/module/download/down.jsp?colID=2790&i_ID=189500"
                target="_blank"
                rel="noreferrer"
              >
                到国家知识产权局核对现行《专利审查指南》 ↗
              </a>
            </details>
          </section>
        </div>
      </div>
      <div className="un-notice" role="status" aria-live="polite">
        {notice}
      </div>
    </div>
  );
}
