import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { categories } from '../../data';
import type { CategoryId, Project } from '../../data';
import { emptyProfile } from '../utility/naming';
import { progressRequest } from '../utility/progressRequest';
import { GenerationProgress } from '../utility/generationProgress';
import type { ProgressStep } from '../utility/generationProgress';
import { isProblemProposal } from '../product/productProblems';
import type { ProblemProposal } from '../product/productProblems';
import { baseProductName } from './projectManagement';
import type { Company } from './company';

export function ProjectEditor({ initial, onSave, onClose, companies = [], company: lockedCompany }: {
  initial: Partial<Project>; onSave: (project: Partial<Project>, start: boolean) => void; onClose: () => void; companies?: Company[]; company?: Company;
}) {
  const [category, setCategory] = useState<CategoryId>(initial.category || 'utility');
  const [name, setName] = useState(initial.name || '');
  const [company, setCompany] = useState(lockedCompany?.name || companies.find(item => item.id === initial.companyId)?.name || initial.owner || '');
  const initialCompanyName = useRef(company).current;
  const [companyId, setCompanyId] = useState(initial.companyId || '');
  const [product, setProduct] = useState(baseProductName(initial));
  const [description, setDescription] = useState(initial.description || '');
  const [proposal, setProposal] = useState<ProblemProposal>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const patent = category === 'utility' || category === 'invention';
  const technicalChange = !initial.id || category !== initial.category || product.trim() !== baseProductName(initial) ||
    (patent && !initial.naming?.confirmed);
  const invalidate = () => {
    controller.current?.abort(); controller.current = null; setBusy(false); setProposal(undefined); setSelected(''); setError('');
  };
  const close = () => {
    const dirty = name !== (initial.name || '') || company !== initialCompanyName || product !== baseProductName(initial) ||
      description !== (initial.description || '') || category !== (initial.category || 'utility') || !!proposal;
    if (!dirty || window.confirm('有尚未保存的修改，确定放弃吗？')) onClose();
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError('请输入项目名称，不能只包含空格。'); document.getElementById('project-name')?.focus(); return; }
    if (patent && !product.trim()) { setError('请输入基础产品名称。'); document.getElementById('base-product-name')?.focus(); return; }
    const metadata = { id: initial.id, category, name: name.trim(), owner: company.trim(), companyId: companyId || undefined, baseProductName: product.trim(), description: description.trim() };
    if (!patent || !technicalChange) { onSave(metadata, false); return; }
    if (proposal) {
      const problem = proposal.problems.find(item => item.id === selected);
      if (!problem) { setError('请选择一个需要解决的问题。'); return; }
      onSave({ ...metadata, filingStatus: undefined, naming: {
        version: 1, profile: { ...emptyProfile, company: company.trim(), product: product.trim(), business: product.trim(), improvementType: 'structure' },
        candidates: [], selectedName: problem.suggestedName, confirmed: true, problemContext: description.trim(), problemProposal: proposal,
        problemSelection: { product: proposal.product, context: proposal.context, scenario: proposal.scenario, problem },
      } }, true);
      return;
    }
    const active = new AbortController(); controller.current = active;
    setBusy(true); setError(''); setProgress([{ label: '整理候选问题', detail: '正在根据基础产品名和描述生成问题' }]);
    try {
      const { data } = await progressRequest<unknown>('/api/product/problems', { product: product.trim(), context: description.trim(), patentType: category },
        step => { if (controller.current === active) setProgress(current => [...current.slice(-5), step]); },
        AbortSignal.any([active.signal, AbortSignal.timeout(660000)]));
      if (active.signal.aborted || controller.current !== active) return;
      if (!isProblemProposal(data) || data.product !== product.trim() || data.context !== description.trim()) throw new Error('候选问题与当前产品信息不一致，请重试。');
      setProposal(data); setSelected('');
    } catch (cause) {
      if (!active.signal.aborted && controller.current === active) setError(cause instanceof Error ? cause.message : '问题生成失败，请重试。');
    } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <Modal title={initial.id ? '编辑项目' : '新建项目'} onClose={close} wide={!!proposal}>
    <form id="project-form" onSubmit={submit}>
      <p className="form-intro">{patent ? '填写项目信息，在当前弹窗选择问题。下一步将自动开始生成，你可以继续新建项目。' : '记录创意的起点。保存后可以预览并导出材料模板。'}</p>
      {proposal ? <section className="project-problems" aria-labelledby="project-problems-title">
        <button type="button" className="text-button" onClick={invalidate}><ArrowLeft size={15} />返回修改信息</button>
        <h3 id="project-problems-title">选择要解决的问题</h3>
        <p>{company || '未填写公司'} · {product}</p><p>应用场景：{proposal.scenario}</p>
        <div role="radiogroup" aria-label="候选技术问题" className="project-problem-choices">{proposal.problems.map(problem =>
          <label key={problem.id} className={`project-problem-choice ${selected === problem.id ? 'selected' : ''}`}>
            <input type="radio" name="technical-problem" value={problem.id} checked={selected === problem.id} onChange={() => { setSelected(problem.id); setError(''); }} />
            <span><strong>{problem.title}</strong><span>{problem.problem}</span><small>改进目标：{problem.goal}</small><small>建议专利名称：{problem.suggestedName}</small></span>
          </label>)}</div>
      </section> : <>
        <label htmlFor="category">知识产权类型</label>
        <select id="category" value={category} onChange={event => { invalidate(); setCategory(event.target.value as CategoryId); }}>
          {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label htmlFor="project-name">项目名称 <span className="required">*</span></label>
        <input data-autofocus id="project-name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="为项目起一个便于查找的名称" />
        <label htmlFor="owner">{patent ? '公司名称' : '申请人 / 著作权人'} <span className="optional">选填</span></label>
        {lockedCompany ? <input id="owner" value={lockedCompany.name} readOnly /> : initial.id ?
          <select id="owner" value={companies.some(item => item.id === companyId) ? companyId : ''} onChange={event => {
            setCompanyId(event.target.value); setCompany(companies.find(item => item.id === event.target.value)?.name || '');
          }}><option value="">未归属企业</option>{companies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          : <input id="owner" value={company} maxLength={100} onChange={event => setCompany(event.target.value)} placeholder="个人或企业名称" />}
        {lockedCompany && lockedCompany.mainProducts.length > 1 && <p className="field-help">主营产品：{lockedCompany.mainProducts.join('、')}</p>}
        <label htmlFor="base-product-name">基础产品名称 {patent ? <span className="required">*</span> : <span className="optional">选填</span>}</label>
        <input id="base-product-name" list={lockedCompany ? 'company-main-products' : undefined} required={patent} maxLength={100} value={product} onChange={event => { invalidate(); setProduct(event.target.value); }} placeholder="例如：闸门、屏幕，用于产品分类和筛选" />
        {lockedCompany && <datalist id="company-main-products">{lockedCompany.mainProducts.map(value => <option key={value} value={value} />)}</datalist>}
        <p className="field-help">保存你输入的产品分类，生成专利名称后仍可按此筛选。</p>
        <label htmlFor="description">创意描述 <span className="optional">选填</span></label>
        <textarea id="description" rows={4} value={description} maxLength={patent ? Math.max(3000, initial.description?.length || 0) : 5000}
          onChange={event => { invalidate(); setDescription(event.target.value); }} placeholder={patent ? '使用场景、已有要求或需要改进的地方' : categories.find(item => item.id === category)?.hint} />
      </>}
      {busy && <GenerationProgress title="生成候选技术问题" label="整理候选问题" steps={progress} />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer"><span>{proposal ? '选好问题后将开始生成' : '所有操作都在当前页面完成'}</span>
        <button type="submit" className="button primary" disabled={busy || (!!proposal && !selected)}>
          {patent && technicalChange ? proposal ? <ArrowRight size={17} /> : <Sparkles size={17} /> : <Check size={17} />}
          {busy ? '正在生成问题…' : patent && technicalChange ? proposal ? '下一步' : '选择问题' : patent ? '保存修改' : '保存并预览'}
        </button>
      </div>
    </form>
  </Modal>;
}
