import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';
import type { Project } from '../../data';
import type { NamingRecord } from '../utility/naming';
import { saveNamingDraft } from '../../storage/projectStorage';
import { progressRequest } from '../utility/progressRequest';
import { GenerationProgress } from '../utility/generationProgress';
import type { ProgressStep } from '../utility/generationProgress';
import { isProblemProposal } from './productProblems';
import type { TechnicalProblem } from './productProblems';
import './productProblemNaming.css';

export function ProductProblemNaming({ initialDraft, project, onSave, onBack, onAdvanced, patentType }: {
  initialDraft: NamingRecord; project?: Project; onSave: (record: NamingRecord) => void;
  onBack: () => void; onAdvanced: (draft: NamingRecord) => void; patentType: 'utility' | 'invention';
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [context, setContext] = useState(initialDraft.problemContext || initialDraft.problemSelection?.context || initialDraft.problemProposal?.context || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const controller = useRef<AbortController | null>(null);
  const proposal = draft.problemProposal;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const timer = setTimeout(() => { void saveNamingDraft(project?.id, { ...draft, confirmed: false }).then(ok => {
      if (!ok) setError('草稿保存失败，请检查存储连接。');
    }); }, 400);
    return () => clearTimeout(timer);
  }, [draft, project?.id]);
  const changeInput = (value: string, nextContext = context) => {
    controller.current?.abort(); controller.current = null; setBusy(false); setError(''); setProgress([]);
    setContext(nextContext);
    setDraft(d => ({ ...d, profile: { ...d.profile, product: value, business: value, features: '', improvementType: 'structure' },
      problemProposal: undefined, problemSelection: undefined, structureOptions: undefined, structureSelection: undefined,
      options: undefined, candidates: [], selectedName: '', confirmed: false, problemContext: nextContext }));
  };
  async function propose() {
    const product = draft.profile.product.trim();
    if (!product) { setError('请输入产品名称。'); return; }
    const active = new AbortController(); controller.current?.abort(); controller.current = active;
    setBusy(true); setError(''); setProgress([{ label: '整理候选问题', detail: '根据产品和已有描述确定使用场景' }]);
    try {
      const { data } = await progressRequest<unknown>('/api/product/problems', { product, context: context.trim(), patentType },
        step => { if (controller.current === active) setProgress(p => [...p, step]); },
        AbortSignal.any([active.signal, AbortSignal.timeout(660000)]));
      if (active.signal.aborted || controller.current !== active) return;
      if (!isProblemProposal(data) || data.product !== product || data.context !== context.trim()) throw new Error('候选问题格式或产品版本不一致，请重试。');
      setDraft(d => ({ ...d, profile: { ...d.profile, product, business: product }, problemProposal: data,
        problemSelection: undefined, candidates: [], selectedName: '', confirmed: false }));
    } catch (cause) {
      if (!active.signal.aborted && controller.current === active) setError(cause instanceof Error ? cause.message : '生成问题失败，请重试。');
    } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  function choose(problem: TechnicalProblem) {
    if (!proposal) return;
    setDraft(d => ({ ...d, problemSelection: { product: proposal.product, context: proposal.context, scenario: proposal.scenario, problem },
      selectedName: problem.suggestedName, candidates: [{ name: problem.suggestedName, product: proposal.product,
        feature: '', basis: problem.problem, inferred: true }] }));
  }
  return <div className="utility-naming pp-naming" data-testid="product-problem-naming">
    <button className="un-back" onClick={onBack}><ArrowLeft size={16} />返回工作台</button>
    <header className="un-heading"><div><h1>从一个产品开始</h1><p>输入产品名称，选择要解决的问题，系统自动整理结构方案和申请文本。</p></div></header>
    <section className="un-panel">
      <form onSubmit={event => { event.preventDefault(); void propose(); }}>
        <label className="pp-field" htmlFor="pp-product">产品名称<input id="pp-product" value={draft.profile.product} maxLength={100}
          placeholder="例如：闸门、纸箱、夹具" onChange={e => changeInput(e.target.value)} /></label>
        <details className="pp-extra"><summary>补充已有描述（可选）</summary>
          <label className="pp-field" htmlFor="pp-context">使用场景或已有要求<textarea id="pp-context" value={context} maxLength={3000}
            placeholder="有现成产品或明确要求时填写；留空由系统提出方案。" onChange={e => changeInput(draft.profile.product, e.target.value)} /></label>
          <label className="pp-field" htmlFor="pp-company">企业名称（可选）<input id="pp-company" value={draft.profile.company} maxLength={100}
            onChange={e => setDraft(d => ({ ...d, profile: { ...d.profile, company: e.target.value } }))} /></label>
        </details>
        <button className="button primary" type="submit" disabled={busy || !draft.profile.product.trim()}><Sparkles size={17} />{busy ? '正在生成问题…' : proposal ? '重新生成问题' : '生成候选问题'}</button>
      </form>
      {busy && <GenerationProgress title="生成候选技术问题" label="整理候选技术问题" steps={progress} />}
      {error && <p className="un-error" role="alert">{error}</p>}
    </section>
    {proposal && <section className="un-panel pp-problems" aria-labelledby="pp-problems-title">
      <h2 id="pp-problems-title">选择要解决的问题</h2><p>应用场景：{proposal.scenario}</p>
      <div className="pp-choices" role="radiogroup" aria-label="候选技术问题">{proposal.problems.map(problem => <label className="pp-choice" key={problem.id}>
        <input type="radio" name="technical-problem" checked={draft.problemSelection?.problem.id === problem.id} onChange={() => choose(problem)} />
        <span><strong>{problem.title}</strong><span>{problem.problem}</span><small>改进目标：{problem.goal}</small></span>
      </label>)}</div>
      {draft.problemSelection && <p>申请名称：{draft.selectedName}</p>}
      <button className="button primary" disabled={!draft.problemSelection || busy} onClick={() => onSave({ ...draft, confirmed: true })}>按此问题继续<ArrowRight size={17} /></button>
    </section>}
    <button className="button secondary pp-advanced" onClick={() => onAdvanced({ ...draft, problemProposal: undefined, problemSelection: undefined,
      candidates: [], selectedName: '', confirmed: false })}>使用已有特征拟名</button>
  </div>;
}
