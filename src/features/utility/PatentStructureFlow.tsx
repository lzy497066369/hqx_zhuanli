import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, Sparkles, Trash2 } from 'lucide-react';
import { GenerationProgress } from './generationProgress';
import type { ProgressStep } from './generationProgress';
import { progressRequest, withAiRetry } from './progressRequest';
import type { Project, UtilityDrawing } from '../../data';
import { patentStructureSource } from './patentStructure';
import { mergeStructureFacts, normalizeStructureFacts } from './patentStructure';
import type { ConfirmedStructureFact, InnovationNameCandidate, PatentStructureResponse, ProductBrief } from './patentStructure';
import type { StructureDraft, StructureStatus } from './structureDraft';
import { bindCompiledIds } from './structureCompiler';
import type { CompileResult } from './structureCompiler';
import { namingStructureInput } from './namingStructureInput';
import { improvementTypes } from './naming';
import { isGeometryAlternatives, isGeometryRevision, isStructureEvidenceOptions, missingStructureEvidenceCategories, structureEvidenceCategoryLabels } from './structureEvidence';
import type { StructureAssistanceResponse, StructureEvidenceCategory, StructureEvidenceOption, StructureEvidenceSelection } from './structureEvidence';
import { isStructureAnswerSuggestions } from './structureAnswers';
import type { StructureAnswerSuggestion } from './structureAnswers';
import { geometryShapeLabels } from './geometrySpec';
import type { PatentShape } from './geometrySpec';
import { buildContentAssembly, CONTENT_MODEL_REVISION } from './contentDrawing';
import { UtilityFigure } from './UtilityFigure';
import { buildStructureDraftFromSkeleton, isStructureSkeleton, skeletonValidationErrors, structureSkeletonRelationOptions, structureSkeletonShapeOptions } from './structureSkeleton';
import type { StructureSkeleton, StructureSkeletonResponse } from './structureSkeleton';
import { isPatentResearch } from './patentResearch';
import type { PatentResearch } from './patentResearch';
import { assemblyGeometryIssues } from './assemblyGeometry';

function initialSize(shape: PatentShape): [number, number, number] {
  if (shape === 'sphere') return [1, 0, 0];
  if (shape === 'cylinder') return [1, 1, 0];
  if (shape === 'tube' || shape === 'torus') return [2, 1, shape === 'tube' ? 1 : 0];
  if (shape === 'spur_gear' || shape === 'ring_gear') return [1, 12, 1];
  if (shape === 'prism') return [1, 4, 1];
  if (shape === 'cone') return [1, 1, 0];
  if (shape === 'threaded_cylinder') return [1, 2, 1];
  return [1, 1, 1];
}

const automaticGenerationFailure = '结构自动生成失败，尚未采用；请点击生成按钮重试。已有模型、附图和文案不会被覆盖。';

class ApiFailure extends Error {
  code?: string;
  details: string[];
  requestId?: string;
  constructor(message: string, code?: string, details: string[] = [], requestId?: string) {
    super(message);
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}


async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const requestIdHeader = response.headers.get('X-Structure-Request-Id');
  const requestId = requestIdHeader && /^[0-9a-f-]{36}$/u.test(requestIdHeader) ? requestIdHeader : undefined;
  const value = await response.json().catch(() => ({}));
  const error = value && typeof value === 'object' && 'error' in value ? (value as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error : undefined;
  const knownCode = typeof error?.code === 'string' ? error.code : undefined;
  const knownCodes = new Set(['AI_INVALID_STRUCTURE', 'AI_INVALID_OUTPUT', 'AI_INVALID_JSON', 'AI_INCOMPLETE', 'AI_AUTH', 'AI_RATE_LIMIT', 'LOCAL_RATE_LIMIT', 'AI_UPSTREAM', 'AI_NETWORK', 'AI_TIMEOUT', 'AI_ATTEMPT_TIMEOUT', 'AI_MODEL_TIMEOUT', 'AI_TOTAL_TIMEOUT', 'STRUCTURE_VALIDATION_FAILED']);
  const details = Array.isArray(error?.details) ? error.details.filter((detail): detail is string => typeof detail === 'string').slice(0, 8) : [];
  if (!response.ok) throw new ApiFailure(knownCode && knownCodes.has(knownCode) && typeof error?.message === 'string' ? error.message : automaticGenerationFailure, knownCode && knownCodes.has(knownCode) ? knownCode : undefined, knownCode && knownCodes.has(knownCode) ? details : [], requestId);
  if (value && typeof value === 'object' && 'success' in value && (value as { success?: unknown }).success === false) {
    const result = value as { code?: unknown; message?: unknown; errors?: unknown };
    const resultCode = typeof result.code === 'string' ? result.code : undefined;
    const resultDetails = Array.isArray(result.errors) ? result.errors.filter((detail): detail is string => typeof detail === 'string').slice(0, 8) : [];
    throw new ApiFailure(typeof result.message === 'string' ? result.message : automaticGenerationFailure, resultCode, resultDetails);
  }
  return value as T;
}
type AssistanceResponse = StructureAssistanceResponse & { candidate?: InnovationNameCandidate };
type NormalizedCompileResult = CompileResult & { normalizedDraft?: StructureDraft };

function failureMessage(cause: unknown) {
  if (!(cause instanceof ApiFailure)) return cause instanceof Error && /与已确认|未通过/.test(cause.message) ? cause.message : automaticGenerationFailure;
  const labels: Record<string, string> = {
    AI_AUTH: 'AI 鉴权失败，请检查服务端密钥和模型权限。', AI_RATE_LIMIT: 'AI 请求受限，请稍后重试或检查额度。', LOCAL_RATE_LIMIT: '本机生成次数已达限额，请稍后重试。',
    AI_TIMEOUT: '结构生成超时，请稍后重试。', AI_ATTEMPT_TIMEOUT: 'AI 单次调用超时，请稍后重试。', AI_MODEL_TIMEOUT: '结构骨架模型单次调用超时，请稍后重试。', AI_TOTAL_TIMEOUT: '结构生成超过请求总时限，请稍后重试。', AI_NETWORK: '无法连接 AI 服务，请检查网络后重试。', AI_UPSTREAM: '上游 AI 服务失败，请稍后重试。',
    AI_INVALID_JSON: 'AI 返回的 JSON 格式错误，请重试。', AI_INVALID_OUTPUT: 'AI 返回的结构骨架协议错误，请重试。', AI_INVALID_STRUCTURE: '结构骨架未通过校验，请核对资料后重试。',
    STRUCTURE_VALIDATION_FAILED: '结构草案未通过离线确定性校验，已有模型不会被覆盖。',
  };
  const details = cause.details.slice(0, 4).join('；');
  return `${labels[cause.code || ''] || cause.message}${details ? ` ${details}` : ''} 已有模型、附图和文案不会被覆盖。${cause.requestId ? ` 诊断编号：${cause.requestId}` : ''}`;
}

function mergeEvidence(current: StructureEvidenceSelection | undefined, options: StructureEvidenceOption[], selectedIds: string[]): StructureEvidenceSelection {
  const selected = options.filter(option => selectedIds.includes(option.id));
  const previous = current?.options.filter(option => current.selectedIds.includes(option.id)) || [];
  const merged = [...previous, ...selected].map((option, index) => ({ ...option, id: `E${String(index + 1).padStart(2, '0')}` }));
  return { version: 1, options: merged, selectedIds: merged.map(option => option.id), confirmed: true };
}

export function PatentStructureFlow({ project, drawing, onApply, onStatus, onEvidenceConfirmed, onFactsConfirmed, onSkeleton, onAssistance, onComplete }: {
  project: Project; drawing: UtilityDrawing;
  onApply: (brief: ProductBrief, candidates: InnovationNameCandidate[], candidate: InnovationNameCandidate, response: PatentStructureResponse, draft: StructureDraft) => boolean;
  onStatus: (status: StructureStatus, error?: string) => void;
  onEvidenceConfirmed: (selection: StructureEvidenceSelection) => void;
  onFactsConfirmed: (facts: ConfirmedStructureFact[]) => void;
  onSkeleton: (skeleton: StructureSkeleton | undefined) => void;
  onAssistance: (result: StructureAssistanceResponse) => void;
  onComplete?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => drawing.structureError && drawing.structureError !== drawing.structureAssistance?.summary ? drawing.structureError : '');
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [evidence, setEvidence] = useState<StructureEvidenceSelection | undefined>(() =>
    drawing.pendingStructureEvidence?.confirmed ? drawing.pendingStructureEvidence :
    drawing.patentStructureModel?.productTitle === project.name && drawing.productBrief?.structureEvidence?.confirmed
      ? drawing.productBrief.structureEvidence : namingStructureInput(project)?.brief.structureEvidence);
  const [assistance, setAssistance] = useState<AssistanceResponse | null>(drawing.structureAssistance || null);
  const [facts, setFacts] = useState<ConfirmedStructureFact[]>(() => normalizeStructureFacts(drawing.pendingStructureFacts ||
    (drawing.patentStructureModel?.productTitle === project.name ? drawing.productBrief?.confirmedFacts : undefined)));
  const [skeleton, setSkeleton] = useState<StructureSkeleton | undefined>(() => drawing.pendingStructureSkeleton?.title === project.name ? drawing.pendingStructureSkeleton : undefined);
  const [research, setResearch] = useState<PatentResearch | undefined>();
  const [skeletonVerified, setSkeletonVerified] = useState(false);
  const [answerSuggestions, setAnswerSuggestions] = useState<StructureAnswerSuggestion[]>([]);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState('');
  const [selectedGeometryId, setSelectedGeometryId] = useState('');
  const [geometryVerified, setGeometryVerified] = useState(false);
  const [revisionVerified, setRevisionVerified] = useState(false);
  const [suggestions, setSuggestions] = useState<StructureEvidenceOption[]>([]);
  const [chosenIds, setChosenIds] = useState<string[]>([]);
  const [evidenceReady, setEvidenceReady] = useState(false);
  const [generationComplete, setGenerationComplete] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const revision = useRef(0);
  const answerRevision = useRef(0);
  const running = useRef(false);
  const generationController = useRef<AbortController | null>(null);
  const suggestionController = useRef<AbortController | null>(null);
  const answerController = useRef<AbortController | null>(null);
  useEffect(() => () => { revision.current++; answerRevision.current++; generationController.current?.abort(); suggestionController.current?.abort(); answerController.current?.abort(); }, []);
  const input = namingStructureInput(project);
  const assemblyIssues = useMemo(() => skeleton && isStructureSkeleton(skeleton) ? assemblyGeometryIssues(skeleton) : [], [skeleton]);
  const highlightedComponentIds = skeleton?.components.flatMap((component, index) => assemblyIssues.some(issue => issue.components.includes(component.name)) ? [`C${String(index + 1).padStart(2, '0')}`] : []) || [];
  const preview = useMemo(() => {
    if (!skeleton || !skeleton.components.every(component => component.geometry && component.geometry.shape === component.geometryShape)) return null;
    try {
      return buildContentAssembly({ revision: CONTENT_MODEL_REVISION, title: skeleton.title, source: 'preview', generatedAt: '',
        components: skeleton.components.map((component, index) => ({ id: index + 1, componentId: `C${String(index + 1).padStart(2, '0')}`, referenceNo: component.referenceNo, name: component.name, visualFeature: component.visualFeature, ...component.geometry! })),
        detailPartId: 1 });
    } catch { return null; }
  }, [skeleton]);
  const needEvidence = !!input && (!evidence?.confirmed || missingStructureEvidenceCategories(evidence).length > 0);
  const confirmedOptions = evidence?.options.filter(option => evidence.selectedIds.includes(option.id)) || [];
  const updateSkeleton = (updated: StructureSkeleton) => { setSkeleton(updated); onSkeleton(updated); setSkeletonVerified(false); setError(''); };
  // 生成失败或要求补充资料时只清空当前渲染，不把删除写回存储：用户已核对好的骨架
  // 是上一次的成果，失败不应销毁它，否则会与「已有成果不会被覆盖」的承诺矛盾。
  const clearSkeleton = () => { setSkeleton(undefined); setSkeletonVerified(false); };
  const loadSuggestions = async (questions: string[] = []) => {
    if (!input || suggestionBusy || !needEvidence) return;
    const startedAt = revision.current;
    suggestionController.current?.abort();
    const controller = new AbortController();
    suggestionController.current = controller;
    setSuggestionBusy(true); setError('');
    try {
      const result = await withAiRetry(() => postJson<{ options: StructureEvidenceOption[] }>('/api/utility/structure-evidence-options', { profile: project.naming?.profile, questions, existingSelection: evidence }, controller.signal), {
        signal: controller.signal,
        onRetry: () => { if (startedAt === revision.current) setError('请求受限，5 秒后自动重试一次…'); },
      });
      if (startedAt !== revision.current) return;
      setError('');
      if (!isStructureEvidenceOptions(result.options, ['component', 'relationship', 'motion', 'geometry', 'problem'])) throw new Error('结构资料选项不完整，请重新生成。');
      setSuggestions(result.options); setChosenIds([]); setEvidenceReady(false);
    } catch (cause) { if (controller.signal.aborted) return; if (startedAt === revision.current) setError(failureMessage(cause)); }
    finally { if (suggestionController.current === controller) suggestionController.current = null; if (startedAt === revision.current) setSuggestionBusy(false); }
  };
  const generate = async (evidenceOverride?: StructureEvidenceSelection, factsOverride?: ConfirmedStructureFact[]) => {
    if (running.current) return;
    if (!input) { setError('请返回第 1 步，确认并保存有效名称及产品资料。'); return; }
    const confirmedEvidence = evidenceOverride || evidence;
    if (!confirmedEvidence?.confirmed || missingStructureEvidenceCategories(confirmedEvidence).length > 0) {
      setEvidenceReady(false);
      setAssistance({ status: 'needs_information', summary: '需要补充资料', questions: ['请选择并确认产品的结构、连接、运动及几何资料。'], options: [] });
      return;
    }
    const { candidate } = input;
    const brief = { ...input.brief, structureEvidence: confirmedEvidence, confirmedFacts: normalizeStructureFacts(factsOverride || facts) };
    const startedAt = ++revision.current;
    setResearch(undefined);
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    // 服务端结构骨架总预算 240 秒；每次尝试独立 250 秒超时，超时自动重试一次。
    running.current = true;
    setGenerationComplete(false);
    setProgressSteps([{ label: '等待结构骨架', detail: '正在整理部件、连接和运动关系' }]);
    setBusy(true); setError(''); onStatus('AI_GENERATING');
    try {
      const { data: result } = await withAiRetry((signal) => progressRequest<StructureSkeletonResponse>('/api/utility/structure-skeleton', { brief, candidate, requireEvidence: true }, step => {
        if (startedAt === revision.current) setProgressSteps(previous => [...previous, step]);
      }, signal), {
        signal: controller.signal,
        attemptTimeoutMs: 250_000,
        onRetry: () => { if (startedAt === revision.current) setProgressSteps(previous => [...previous, { label: '请求受限，自动重试', detail: '5 秒后重新发起结构骨架请求（仅重试一次）' }]); },
      });
      if (startedAt !== revision.current) return;
      if (result.status === 'needs_information' || result.status === 'unsupported') {
        // 只清当前渲染，不把删除写回存储：已核对的骨架是上一次成果，不应被本轮结果销毁。
        clearSkeleton();
        setResearch(undefined);
        setAssistance(result); setAnswerSuggestions([]); setAnswerError(''); setSelectedGeometryId(''); setGeometryVerified(false); setRevisionVerified(false); setSuggestions([]); setChosenIds([]); setEvidenceReady(false);
        onAssistance(result);
        return;
      }
      if (result.status !== 'ready' || !isStructureSkeleton(result.skeleton) || !isPatentResearch(result.research) || skeletonValidationErrors(result.skeleton).length || result.candidate?.name !== candidate.name || result.source !== patentStructureSource(brief, candidate) || result.skeleton.title !== candidate.name) throw new ApiFailure('结构骨架协议错误，未采用该结果。', 'AI_INVALID_OUTPUT');
      setSkeleton(result.skeleton); onSkeleton(result.skeleton); setSkeletonVerified(false);
      setResearch(result.research);
      setAssistance(null); setEvidenceReady(false); setSuggestions([]); setChosenIds([]);
    } catch (cause) {
      if (startedAt === revision.current) {
        const streamed = cause as { code?: string; details?: string[]; requestId?: string; message?: string };
        const clientTimedOut = streamed?.code === 'AI_ATTEMPT_TIMEOUT';
        const message = clientTimedOut ? '结构生成连续两次超时（单次 250 秒），已有成果未被修改；请稍后重试。' : failureMessage(cause instanceof ApiFailure ? cause : streamed?.code ? new ApiFailure(streamed.message || automaticGenerationFailure, streamed.code, streamed.details, streamed.requestId) : cause);
        setEvidenceReady(false); setGenerationComplete(false); setError(message); onStatus('FAILED', message);
      }
    } finally { if (generationController.current === controller) generationController.current = null; running.current = false; if (startedAt === revision.current) setBusy(false); }
  };
  const confirmSkeleton = async () => {
    if (running.current || !input || !skeleton || !skeletonVerified) return;
    if (!research || !isPatentResearch(research)) { setError('缺少已验证的检索证据，不能编译结构模型。'); return; }
    const brief = { ...input.brief, structureEvidence: evidence, confirmedFacts: normalizeStructureFacts(facts) };
    const { candidate } = input;
    const assembled = buildStructureDraftFromSkeleton({ brief, candidate, skeleton });
    if (!assembled.success) { setError(`结构骨架尚不能编译：${assembled.errors.join('；')} 已有模型、附图和文案不会被覆盖。`); return; }
    const startedAt = ++revision.current;
    running.current = true;
    setBusy(true); setError(''); setGenerationComplete(false);
    setProgressSteps([{ label: '离线编译模型', detail: '正在编译部件标号、连接与附图规格' }]);
    onStatus('STRUCTURE_CONFIRMED');
    try {
      const compiled = await postJson<NormalizedCompileResult>('/api/utility/compile-structure', assembled.draft);
      if (startedAt !== revision.current) return;
      if (!compiled.success) throw new ApiFailure('离线编译未通过。', 'STRUCTURE_VALIDATION_FAILED', compiled.errors);
      if (compiled.model.productTitle !== candidate.name || compiled.model.improvementType !== brief.improvementType) throw new Error('编译结果与已确认名称或改进类型不一致。');
      const response: PatentStructureResponse = { model: compiled.model, candidate, source: patentStructureSource(brief, candidate), researchSummary: research.summary, research, providerModel: 'manual/offline', generatedAt: new Date().toISOString() };
      const bound = bindCompiledIds(compiled.normalizedDraft || assembled.draft, compiled.mapping);
      if (!onApply(brief, [], candidate, response, bound)) throw new Error('图纸视图未通过实际标号校验，旧模型未替换。');
      setSkeleton(undefined); setResearch(undefined); setSkeletonVerified(false); setAssistance(null); setGenerationComplete(true);
    } catch (cause) {
      if (startedAt === revision.current) { const message = failureMessage(cause); setError(message); onStatus('FAILED', message); }
    } finally { running.current = false; if (startedAt === revision.current) setBusy(false); }
  };
  const questions = assistance?.status === 'needs_information' && !needEvidence ? assistance.questions : [];
  const questionsKey = JSON.stringify(questions);
  const unansweredQuestions = questions.filter(question => !facts.some(fact => fact.question === question));
  const loadAnswers = async (requested: string[]) => {
    if (!input || !requested.length) return;
    answerController.current?.abort();
    const controller = new AbortController();
    answerController.current = controller;
    const startedAt = ++answerRevision.current;
    setAnswerBusy(true); setAnswerError(''); setAnswerSuggestions([]);
    try {
      const result = await withAiRetry(() => postJson<{ suggestions: StructureAnswerSuggestion[] }>('/api/utility/structure-answers', {
        brief: { ...input.brief, structureEvidence: evidence, confirmedFacts: normalizeStructureFacts(facts) }, candidate: input.candidate, questions: requested,
      }, controller.signal), {
        signal: controller.signal,
        onRetry: () => { if (startedAt === answerRevision.current) setAnswerError('请求受限，5 秒后自动重试一次…'); },
      });
      if (startedAt !== answerRevision.current) return;
      setAnswerError('');
      if (!isStructureAnswerSuggestions(result.suggestions, requested)) throw new Error('建议答案不完整，请重试。');
      setAnswerSuggestions(result.suggestions);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (startedAt === answerRevision.current) setAnswerError(cause instanceof Error && !(cause instanceof ApiFailure) ? cause.message : failureMessage(cause));
    } finally { if (answerController.current === controller) answerController.current = null; if (startedAt === answerRevision.current) setAnswerBusy(false); }
  };
  useEffect(() => {
    const requested = JSON.parse(questionsKey) as string[];
    if (needEvidence || !requested.length || requested.every(question => facts.some(fact => fact.question === question))) {
      answerRevision.current++; setAnswerSuggestions([]); setAnswerBusy(false); return;
    }
    void loadAnswers(requested.filter(question => !facts.some(fact => fact.question === question)));
    const answerRef = answerRevision;
    return () => { answerRef.current++; answerController.current?.abort(); };
    // A new question set triggers a fresh request; previously adopted answers cannot trigger a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionsKey, needEvidence]);
  const canConfirmFacts = unansweredQuestions.length > 0 &&
    isStructureAnswerSuggestions(answerSuggestions, unansweredQuestions) &&
    facts.length + unansweredQuestions.length <= 16;
  const updatedFacts = mergeStructureFacts(facts, answerSuggestions.map(({ question, answer }) => ({ question, answer: answer.trim(), origin: 'model_proposal' as const })));
  const geometryAlternatives = assistance?.status === 'unsupported' && isGeometryAlternatives(assistance.geometryAlternatives) ? assistance.geometryAlternatives : [];
  const geometryFact = (component: string) => `几何表示确认：${component}`;
  const geometryAnswer = (alternative: (typeof geometryAlternatives)[number]) =>
    `已核对实际形状：${alternative.condition}；${alternative.component}可用${geometryShapeLabels[alternative.shape]}表示。${alternative.description}`;
  const availableGeometry = geometryAlternatives.filter(alternative =>
    !facts.some(fact => fact.question === geometryFact(alternative.component) && fact.answer === geometryAnswer(alternative)));
  const selectedGeometry = availableGeometry.find(alternative => alternative.id === selectedGeometryId);
  const canConfirmGeometry = !!selectedGeometry && geometryVerified &&
    (facts.some(fact => fact.question === geometryFact(selectedGeometry.component)) || facts.length < 16);
  const geometryRevision = assistance?.status === 'unsupported' && isGeometryRevision(assistance.geometryRevision) ? assistance.geometryRevision : undefined;
  const revisionFact = geometryRevision && `拟议几何修改：${geometryRevision.component}`;
  const revisionAnswer = geometryRevision && `拟修改${geometryRevision.component}：${geometryRevision.change}；改用${geometryShapeLabels[geometryRevision.shape]}示意；保留创新结构：${geometryRevision.preservedInnovation}；待核对：${geometryRevision.condition}`;
  const revisionAvailable = !!geometryRevision && !!revisionFact && !!revisionAnswer &&
    !facts.some(fact => fact.question === revisionFact && fact.answer === revisionAnswer);
  const canConfirmRevision = revisionAvailable && revisionVerified &&
    (facts.some(fact => fact.question === revisionFact) || facts.length < 16);
  return <section className="uw-patent-flow" data-testid="patent-structure-flow">
    <div className="uw-patent-flow-head"><div><span className="uw-flow-kicker">STEP 02 · PATENT STRUCTURE MODEL</span><h2>根据名称生成结构</h2><p>已确定名称：{project.name}。结构草案来自此名称及第 1 步资料，通过校验和离线编译后成为统一模型。</p></div><Sparkles size={24} /></div>
    <div className="uw-flow-actions"><button className="button primary" onClick={() => void generate()} disabled={busy || !input || needEvidence || assistance?.status === 'unsupported' || (!!unansweredQuestions.length && !error)}><Sparkles size={16} />{busy ? '生成中…' : skeleton ? '重新生成结构骨架' : drawing.patentStructureModel?.productTitle === project.name ? '按名称重新生成结构' : '按名称生成结构'}</button></div>
    {skeleton && <div className="uw-evidence uw-skeleton" data-testid="structure-skeleton">
      <h3>核对结构骨架</h3><p>{skeleton.summary}</p>
      <label>外观主体<input aria-label="外观主体" maxLength={300} value={skeleton.visualSubject || ''} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, visualSubject: event.target.value })} /></label>
      <label>主体部件<select aria-label="主体部件" value={skeleton.subjectComponent || ''} disabled={busy} onChange={event => { const name = event.target.value; updateSkeleton({ ...skeleton, subjectComponent: name, components: [...skeleton.components].sort((a, b) => Number(b.name === name) - Number(a.name === name)) }); }}><option value="">待核对</option>{skeleton.components.map(component => <option key={component.name} value={component.name}>{component.name}</option>)}</select></label>
      <fieldset><legend>部件与几何形状</legend><p>附图标号用于附图和专利文案，内部 C 编号仅供系统关联；可填写 1、201、206、301，留空时按部件顺序自动生成。</p>{skeleton.components.map((component, index) => <div className="uw-skeleton-row" key={index}>
        <label>部件名称<input aria-label={`部件 ${index + 1} 名称`} maxLength={40} value={component.name} disabled={busy} onChange={event => { const previous = component.name; const next = event.target.value; updateSkeleton({ ...skeleton, subjectComponent: skeleton.subjectComponent === previous ? next : skeleton.subjectComponent, components: skeleton.components.map((item, i) => i === index ? { ...item, name: next } : item), relationships: skeleton.relationships.map(item => ({ ...item, from: item.from === previous ? next : item.from, to: item.to === previous ? next : item.to })), motions: skeleton.motions.map(item => ({ ...item, component: item.component === previous ? next : item.component, drivenBy: item.drivenBy === previous ? next : item.drivenBy })) }); }} /></label>
        <label>附图标号<input aria-label={`${component.name} 附图标号`} inputMode="numeric" maxLength={3} value={component.referenceNo || ''} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, referenceNo: event.target.value || undefined } : item) })} /></label>
        <label>作用<input aria-label={`${component.name} 作用`} maxLength={500} value={component.purpose} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, purpose: event.target.value } : item) })} /></label>
        <label>装配位置<input aria-label={`${component.name} 装配位置`} maxLength={500} value={component.position} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, position: event.target.value } : item) })} /></label>
        <label>类别<select aria-label={`${component.name} 类别`} value={component.kind} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, kind: event.target.value as typeof item.kind } : item) })}><option value="base">基础部件</option><option value="innovation">创新部件</option></select></label>
        <label>形状<select aria-label={`${component.name} 形状`} value={component.geometryShape || ''} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, geometryShape: event.target.value ? event.target.value as typeof item.geometryShape : undefined, geometry: item.geometry?.shape === event.target.value ? item.geometry : undefined } : item) })}><option value="">待核对</option>{structureSkeletonShapeOptions.map(shape => <option key={shape} value={shape}>{geometryShapeLabels[shape]}</option>)}</select></label>
        <label>外观特征<input aria-label={`${component.name} 外观特征`} maxLength={300} value={component.visualFeature || ''} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, visualFeature: event.target.value } : item) })} /></label>
        {!component.geometry && component.geometryShape && <button type="button" className="button secondary" disabled={busy} onClick={() => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, geometry: { shape: item.geometryShape!, position: [0, 0, 0], size: initialSize(item.geometryShape!), rotation: [0, 0, 0] } } : item) })}>设置{component.name || '部件'}几何</button>}
        {component.geometry && (['position', 'size', 'rotation'] as const).flatMap(field => ([0, 1, 2] as const).map(axis => <label key={`${field}-${axis}`}>{field === 'position' ? '位置' : field === 'size' ? '尺寸' : '旋转'} {['X', 'Y', 'Z'][axis]}<input type="number" step="any" aria-label={`${component.name} ${field} ${['X', 'Y', 'Z'][axis]}`} value={component.geometry![field][axis]} disabled={busy} onChange={event => {
          const value = event.target.valueAsNumber;
          if (!Number.isFinite(value)) return;
          updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, geometry: { ...item.geometry!, [field]: item.geometry![field].map((current, position) => position === axis ? value : current) as [number, number, number] } } : item) });
        }} /></label>))}
        {component.geometry?.shape === 'box' && <>
          <label className="uw-geometry-confirm"><input type="checkbox" aria-label={`${component.name} 板面网格`} checked={!!component.geometry.surfaceGrid} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, geometry: { ...item.geometry!, surfaceGrid: event.target.checked ? [6, 4] : undefined } } : item) })} />板面网格（仅已核对）</label>
          {component.geometry.surfaceGrid && ([0, 1] as const).map(axis => <label key={`grid-${axis}`}>网格{axis === 0 ? '列' : '行'}数<input type="number" min={1} max={20} step={1} aria-label={`${component.name} 网格${axis === 0 ? '列' : '行'}数`} value={component.geometry!.surfaceGrid![axis]} disabled={busy} onChange={event => { const value = event.target.valueAsNumber; if (!Number.isInteger(value) || value < 1 || value > 20) return; updateSkeleton({ ...skeleton, components: skeleton.components.map((item, i) => i === index ? { ...item, geometry: { ...item.geometry!, surfaceGrid: item.geometry!.surfaceGrid!.map((current, position) => position === axis ? value : current) as [number, number] } } : item) }); }} /></label>)}
        </>}
        <button type="button" className="icon-button" title={`移除${component.name}`} aria-label={`移除${component.name}`} disabled={busy || skeleton.components.length <= 2} onClick={() => updateSkeleton({ ...skeleton, components: skeleton.components.filter((_, i) => i !== index), relationships: skeleton.relationships.filter(item => item.from !== component.name && item.to !== component.name), motions: skeleton.motions.filter(item => item.component !== component.name && item.drivenBy !== component.name) })}><Trash2 size={16} /></button>
      </div>)}<button type="button" className="button secondary" disabled={busy || skeleton.components.length >= 30} onClick={() => updateSkeleton({ ...skeleton, components: [...skeleton.components, { name: '', kind: 'base', purpose: '', position: '', geometryShape: undefined }] })}><Plus size={16} />添加部件</button></fieldset>
      <fieldset><legend>连接关系</legend>{skeleton.relationships.map((relationship, index) => <div className="uw-skeleton-row" key={index}>
        <label>起点<select aria-label={`连接 ${index + 1} 起点`} value={relationship.from} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, relationships: skeleton.relationships.map((item, i) => i === index ? { ...item, from: event.target.value } : item) })}>{skeleton.components.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>关系<select aria-label={`连接 ${index + 1} 关系`} value={relationship.relation} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, relationships: skeleton.relationships.map((item, i) => i === index ? { ...item, relation: event.target.value as typeof item.relation } : item) })}>{structureSkeletonRelationOptions.map(relation => <option key={relation} value={relation}>{relation}</option>)}</select></label>
        <label>终点<select aria-label={`连接 ${index + 1} 终点`} value={relationship.to} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, relationships: skeleton.relationships.map((item, i) => i === index ? { ...item, to: event.target.value } : item) })}>{skeleton.components.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>连接方式<input aria-label={`连接 ${index + 1} 描述`} maxLength={500} value={relationship.description} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, relationships: skeleton.relationships.map((item, i) => i === index ? { ...item, description: event.target.value } : item) })} /></label>
        <button type="button" className="icon-button" title="移除连接" aria-label={`移除连接 ${index + 1}`} disabled={busy} onClick={() => updateSkeleton({ ...skeleton, relationships: skeleton.relationships.filter((_, i) => i !== index) })}><Trash2 size={16} /></button>
      </div>)}<button type="button" className="button secondary" disabled={busy || skeleton.relationships.length >= 80} onClick={() => updateSkeleton({ ...skeleton, relationships: [...skeleton.relationships, { from: skeleton.components[0].name, to: skeleton.components[1].name, relation: 'connected_to', description: '' }] })}><Plus size={16} />添加连接</button></fieldset>
      <fieldset><legend>运动部件</legend>{skeleton.motions.map((motion, index) => <div className="uw-skeleton-row" key={index}>
        <label>部件<select aria-label={`运动 ${index + 1} 部件`} value={motion.component} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, motions: skeleton.motions.map((item, i) => i === index ? { ...item, component: event.target.value } : item) })}>{skeleton.components.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>类型<select aria-label={`运动 ${index + 1} 类型`} value={motion.type} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, motions: skeleton.motions.map((item, i) => i === index ? { ...item, type: event.target.value as typeof item.type } : item) })}><option value="rotary">旋转</option><option value="linear">直线</option></select></label>
        <label>驱动部件<select aria-label={`运动 ${index + 1} 驱动部件`} value={motion.drivenBy} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, motions: skeleton.motions.map((item, i) => i === index ? { ...item, drivenBy: event.target.value } : item) })}>{skeleton.components.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>轨迹<input aria-label={`运动 ${index + 1} 轨迹`} maxLength={500} value={motion.path} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, motions: skeleton.motions.map((item, i) => i === index ? { ...item, path: event.target.value } : item) })} /></label>
        <label>作用<input aria-label={`运动 ${index + 1} 作用`} maxLength={500} value={motion.purpose} disabled={busy} onChange={event => updateSkeleton({ ...skeleton, motions: skeleton.motions.map((item, i) => i === index ? { ...item, purpose: event.target.value } : item) })} /></label>
        <button type="button" className="icon-button" title="移除运动" aria-label={`移除运动 ${index + 1}`} disabled={busy} onClick={() => updateSkeleton({ ...skeleton, motions: skeleton.motions.filter((_, i) => i !== index) })}><Trash2 size={16} /></button>
      </div>)}<button type="button" className="button secondary" disabled={busy || skeleton.motions.length >= 30} onClick={() => updateSkeleton({ ...skeleton, motions: [...skeleton.motions, { component: skeleton.components[0].name, type: 'rotary', drivenBy: skeleton.components[1].name, path: '', purpose: '' }] })}><Plus size={16} />添加运动</button></fieldset>
      {assemblyIssues.length > 0 && <div role="alert" data-testid="assembly-issues" className="uw-assembly-issues">
        <strong>装配几何待核对</strong>
        <p className="uw-assembly-summary">{assemblyIssues.filter(issue => issue.severity === 'error').length > 0
          ? `有 ${assemblyIssues.filter(issue => issue.severity === 'error').length} 项确定性错误会阻止编译；请先修正几何或连接关系。`
          : '当前问题为人工核对提示，不会单独阻止编译。'}</p>
        <ul>{assemblyIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>
          <span className={`uw-assembly-severity ${issue.severity}`}>{issue.severity === 'error' ? '错误' : '警告'}</span>
          <span>{issue.message}</span>
          <small><strong>处理建议：</strong>{issue.recommendation}</small>
        </li>)}</ul>
      </div>}
      {preview && <div className="uw-skeleton-preview" data-testid="structure-preview"><h3>整体结构预览</h3><UtilityFigure model={preview} parts={[]} figure="overall" title={skeleton.title} highlightedComponentIds={highlightedComponentIds} />{/H[型形]钢|H形截面|截面呈H形/iu.test(skeleton.title) && skeleton.components.some(component => /(?:上|下)(?:翼缘|翼板)/u.test(component.name) && component.geometry?.shape === 'box' && component.geometry.size[0] > Math.max(component.geometry.size[1], component.geometry.size[2])) && <><h3>沿 X 轴观察的端面</h3><UtilityFigure model={preview} parts={[]} figure="side" title={skeleton.title} highlightedComponentIds={highlightedComponentIds} /></>}</div>}
      <p>形状、尺寸和位置仅用于黑白轮廓线稿示意，非实测数据；关键复杂曲面不能以基础形状替代。</p>
      <label className="uw-geometry-confirm"><input type="checkbox" checked={skeletonVerified} disabled={busy} onChange={event => setSkeletonVerified(event.target.checked)} />我已核对部件、连接、运动和形状，确认关键特征未被简化或遗漏</label>
      <div className="uw-evidence-actions"><button type="button" className="button primary" disabled={busy || !skeletonVerified || !preview || skeletonValidationErrors(skeleton).length > 0 || assemblyIssues.some(issue => issue.severity === 'error')} onClick={() => void confirmSkeleton()}><Check size={16} />确认骨架并编译模型</button></div>
      {assemblyIssues.some(issue => issue.severity === 'error') && <p role="status" className="uw-assembly-blocked">确认按钮已禁用：请先处理上方标记为“错误”的几何间隙、穿插或对齐问题。</p>}
      {!!skeletonValidationErrors(skeleton).length && <p role="status">{skeletonValidationErrors(skeleton).join('；')}</p>}
    </div>}
    {(needEvidence || assistance || suggestions.length > 0 || evidenceReady || generationComplete || drawing.pendingStructureEvidence?.confirmed) && <div className="uw-evidence" aria-live="polite">
      <h3>{generationComplete ? 'Patent Structure Model 已生成' : evidenceReady ? '补充资料已确认' : assistance?.status === 'unsupported' ? '当前几何暂不支持' : assistance ? '需要补充资料' : drawing.pendingStructureEvidence?.confirmed ? '补充资料已保存' : '需要补充资料'}</h3>
      <p>{generationComplete ? '结构模型已完成并保留在当前工作区，下一步请核对下方附图与部件。' : evidenceReady ? `已合并 ${chosenIds.length} 项补充资料，正在重新生成 Patent Structure Model。` : assistance?.summary || (drawing.pendingStructureEvidence?.confirmed ? '资料已保留，点击按名称重新生成结构继续。' : '请核对实际结构资料，确认后才能生成模型。')}</p>
      {generationComplete && <>
        <p role="status">STEP 03 · 绘图与部件已开放，当前页面仍在结构与材料工作区。</p>
        <button type="button" className="button secondary" onClick={() => onComplete?.()}><Check size={16} />继续 STEP 03 · 绘图与部件</button>
      </>}
      {!!assistance?.questions.length && !evidenceReady && (needEvidence || assistance.status === 'unsupported') && <ul>{assistance.questions.map(question => <li key={question}>{question}</li>)}</ul>}
      {!!confirmedOptions.length && !generationComplete && <details open><summary>已确认的结构资料（{confirmedOptions.length} 项）</summary><ul>{confirmedOptions.map(option => <li key={option.id}>{option.label}：{option.detail}</li>)}</ul></details>}
      {!!questions.length && !evidenceReady && <div className="uw-fact-questions">
        <p>模型根据现有资料给出建议方案。审核后确认采用；未核对的实物结构仍标记为待核对。</p>
        {questions.map(question => {
          const suggestion = answerSuggestions.find(item => item.question === question);
          const adopted = facts.find(fact => fact.question === question);
          return <div key={question} className="uw-fact-answer"><strong>{question}</strong>{suggestion ? <><span className="uw-answer-origin">{suggestion.basis === 'supported' ? '资料支持 · 待审核' : '拟议方案 · 待实物核对'}</span><p>{suggestion.answer}</p><small>{suggestion.rationale}</small></> : adopted ? <><span className="uw-answer-origin">{adopted.origin ? '已采纳拟议方案' : '已确认事实'}</span><p>{adopted.answer}</p></> : <p role="status">{answerBusy ? '正在生成建议答案…' : '暂无建议答案'}</p>}</div>;
        })}
        {answerError && <p role="alert">{answerError}</p>}
        {!answerBusy && !!unansweredQuestions.length && !canConfirmFacts && <div className="uw-evidence-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void loadAnswers(unansweredQuestions)}><Sparkles size={16} />重新生成建议答案</button></div>}
        <div className="uw-evidence-actions"><button type="button" className="button primary" disabled={busy || !canConfirmFacts} onClick={() => { setFacts(updatedFacts); onFactsConfirmed(updatedFacts); setAnswerSuggestions([]); void generate(undefined, updatedFacts); }}><Check size={16} />确认采用建议并重新生成结构</button></div>
        {!unansweredQuestions.length && <p>问题已有采纳答案，但本轮未生成可用结构。可点击上方生成按钮重新尝试；若关键形状无法用现有几何表达，请核对资料或使用 CAD 建模。</p>}
      </div>}
      {assistance?.unsupportedReason && <p>{assistance.unsupportedReason}。关键特征不能用现有几何如实表达时，请使用 CAD 建模，不能用通用形状替代。</p>}
      {assistance?.status === 'unsupported' && availableGeometry.length > 0 && !generationComplete && <div className="uw-geometry-alternatives">
        <fieldset><legend>可核对的几何方案</legend>{availableGeometry.map(alternative =>
          <label key={alternative.id} className="uw-geometry-choice"><input type="radio" name="geometry-alternative" checked={selectedGeometryId === alternative.id} disabled={busy} onChange={() => { setSelectedGeometryId(alternative.id); setGeometryVerified(false); }} /><span><strong>{alternative.component} · {geometryShapeLabels[alternative.shape]}</strong><small>{alternative.description}</small><small>适用条件：{alternative.condition}</small></span></label>)}</fieldset>
        {selectedGeometry && <label className="uw-geometry-confirm"><input type="checkbox" checked={geometryVerified} disabled={busy} onChange={event => setGeometryVerified(event.target.checked)} />我已核对实物或图纸，确认所选条件属实，且关键创新特征未被省略</label>}
        <div className="uw-evidence-actions"><button type="button" className="button primary" disabled={busy || !canConfirmGeometry} onClick={() => {
          if (!selectedGeometry) return;
          const updated = [...facts.filter(fact => fact.question !== geometryFact(selectedGeometry.component)), { question: geometryFact(selectedGeometry.component), answer: geometryAnswer(selectedGeometry) }];
          setFacts(updated); onFactsConfirmed(updated); setSelectedGeometryId(''); setGeometryVerified(false); void generate(undefined, updated);
        }}><Check size={16} />确认几何方案并重新生成结构</button></div>
      </div>}
      {assistance?.status === 'unsupported' && geometryAlternatives.length > 0 && !availableGeometry.length && <p>已确认的几何方案仍不能生成可校验模型。请核对关键形状，或改用 CAD 建模。</p>}
      {revisionAvailable && geometryRevision && <div className="uw-geometry-alternatives" data-testid="geometry-revision">
        <fieldset><legend>最小几何修改方案 · 拟议设计</legend>
          <p><strong>{geometryRevision.component} · {geometryShapeLabels[geometryRevision.shape]}</strong></p>
          <p>建议修改：{geometryRevision.change}</p><p>保留创新点：{geometryRevision.preservedInnovation}</p><p>确认条件：{geometryRevision.condition}</p>
        </fieldset>
        <label className="uw-geometry-confirm"><input type="checkbox" checked={revisionVerified} disabled={busy} onChange={event => setRevisionVerified(event.target.checked)} />我同意按此方案修改设计，并将其作为待实物核对的拟议方案</label>
        <div className="uw-evidence-actions"><button type="button" className="button primary" disabled={busy || !canConfirmRevision} onClick={() => {
          if (!revisionFact || !revisionAnswer) return;
          const updated = [...facts.filter(fact => fact.question !== revisionFact), { question: revisionFact, answer: revisionAnswer, origin: 'model_proposal' as const }];
          setFacts(updated); onFactsConfirmed(updated); setRevisionVerified(false); void generate(undefined, updated);
        }}><Check size={16} />采纳修改方案并重新生成结构</button></div>
      </div>}
      {geometryRevision && !revisionAvailable && <p>已采纳的几何修改仍不能生成可校验模型。请核对新的阻碍，或改用 CAD 建模。</p>}
      {!!suggestions.length && <div className="uw-evidence-options">{(Object.keys(structureEvidenceCategoryLabels) as StructureEvidenceCategory[]).map(category => <fieldset key={category}><legend>{structureEvidenceCategoryLabels[category]}</legend>{suggestions.filter(option => option.category === category).map(option => <label key={option.id}><input type="checkbox" checked={chosenIds.includes(option.id)} disabled={evidenceReady || busy} onChange={() => setChosenIds(ids => ids.includes(option.id) ? ids.filter(id => id !== option.id) : [...ids, option.id])} /><span><strong>{option.label}</strong><small>{option.detail}</small></span></label>)}</fieldset>)}
        <div className="uw-evidence-actions">
          <button type="button" className="button secondary" disabled={suggestionBusy || busy} onClick={() => void loadSuggestions(assistance?.questions)}><Sparkles size={16} />{suggestionBusy ? '正在整理选项…' : '重新生成补充选项'}</button>
          <button type="button" className="button primary" disabled={evidenceReady || busy || !chosenIds.length || mergeEvidence(evidence, suggestions, chosenIds).options.length > 30 || missingStructureEvidenceCategories(mergeEvidence(evidence, suggestions, chosenIds)).length > 0} onClick={() => { const merged = mergeEvidence(evidence, suggestions, chosenIds); setEvidence(merged); setEvidenceReady(true); setError(''); onEvidenceConfirmed(merged); void generate(merged); }}><Check size={16} />确认补充资料并重新生成结构</button>
        </div>
        {!!chosenIds.length && !!missingStructureEvidenceCategories(mergeEvidence(evidence, suggestions, chosenIds)).length && <p>尚需确认：{missingStructureEvidenceCategories(mergeEvidence(evidence, suggestions, chosenIds)).map(category => structureEvidenceCategoryLabels[category]).join('、')}</p>}
        {!!chosenIds.length && mergeEvidence(evidence, suggestions, chosenIds).options.length > 30 && <p>最多保存 30 项结构资料，请减少本轮选项。</p>}
      </div>}
      {needEvidence && !suggestions.length && <div className="uw-evidence-actions"><button type="button" className="button secondary" disabled={suggestionBusy || busy} onClick={() => void loadSuggestions(assistance?.questions)}><Sparkles size={16} />{suggestionBusy ? '正在整理选项…' : '生成补充资料选项'}</button></div>}
    </div>}
    {busy && <GenerationProgress title="正在生成 Patent Structure Model" label="结构模型生成进度" steps={progressSteps} next="完成并显示模型" note="已有模型、附图和文案不会被覆盖。" testId="structure-progress" />}
    {!input && <p className="uw-ai-error" role="alert">请返回名称页确认并保存名称与产品资料。</p>}
    {error && <p className="uw-ai-error" role="alert">{error}</p>}
    {drawing.patentStructureModel?.productTitle === project.name && <div className="uw-flow-summary" role="status"><strong>已编译结构模型</strong><span>{drawing.patentStructureModel.improvementType ? `${improvementTypes[drawing.patentStructureModel.improvementType]} · ` : ''}{drawing.patentStructureModel.components.length} 个部件 · {drawing.patentStructureModel.connections.length} 条连接 · {drawing.patentStructureModel.figureSpecs.length} 张附图</span></div>}
  </section>;
}
