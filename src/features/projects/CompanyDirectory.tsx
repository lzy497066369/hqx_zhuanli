import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Building2, FolderOpen, PenLine, Search, Trash2 } from 'lucide-react';
import { Modal } from '../../components/Modal';
import type { Project } from '../../data';
import { newId } from '../../storage/id';
import { companyForProject, companyNameKey, parseMainProducts } from './company';
import type { Company } from './company';
import { isGeneratedPatent } from './projectManagement';

export function CompanyEditor({ initial, companies, onSave, onClose }: {
  initial: Partial<Company>; companies: Company[]; onSave: (company: Company) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial.name || '');
  const [products, setProducts] = useState(initial.mainProducts?.join('、') || '');
  const [error, setError] = useState('');
  const close = () => {
    const dirty = name !== (initial.name || '') || products !== (initial.mainProducts?.join('、') || '');
    if (!dirty || window.confirm('有尚未保存的企业资料，确定放弃吗？')) onClose();
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError('请输入公司名称，不能只包含空格。'); return; }
    if (companies.some(company => company.id !== initial.id && companyNameKey(company.name) === companyNameKey(name))) {
      setError('该企业已存在，请直接进入企业或使用其他公司名称。'); return;
    }
    const mainProducts = parseMainProducts(products);
    if (!mainProducts.length) { setError('请输入至少一项主营产品。'); return; }
    if (mainProducts.length > 50 || mainProducts.some(product => product.length > 100)) { setError('最多填写 50 项主营产品，每项不超过 100 字。'); return; }
    onSave({ id: initial.id || newId(), name: name.trim(), mainProducts, updatedAt: new Date().toISOString() });
  };
  return <Modal title={initial.id ? '编辑企业' : '新增企业'} onClose={close}>
    <form onSubmit={save}>
      <p className="form-intro">填写公司名称和主营产品，创建后可进入该企业管理全部专利。</p>
      <label htmlFor="company-name">公司名称 <span className="required">*</span></label>
      <input id="company-name" data-autofocus required maxLength={100} value={name} onChange={event => { setName(event.target.value); setError(''); }} placeholder="请输入企业完整名称" />
      <label htmlFor="company-products">主营产品 <span className="required">*</span></label>
      <textarea id="company-products" required rows={3} maxLength={5050} value={products} onChange={event => { setProducts(event.target.value); setError(''); }} placeholder="例如：闸门、屏幕" />
      <p className="field-help">多个产品可用顿号、逗号或换行分隔。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer"><span>企业资料会随工作空间保存</span><button type="submit" className="button primary">{initial.id ? '保存企业' : '创建企业'}</button></div>
    </form>
  </Modal>;
}

export function CompanyDirectory({ companies, projects, onOpen, onEdit, onDelete, onCreate, onAll, onUnassigned }: {
  companies: Company[]; projects: Project[]; onOpen: (company: Company) => void; onEdit: (company: Company) => void;
  onDelete: (company: Company) => void; onCreate: () => void; onAll: () => void; onUnassigned: () => void;
}) {
  const [query, setQuery] = useState('');
  const [product, setProduct] = useState('all');
  const products = [...new Set(companies.flatMap(company => company.mainProducts))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const visible = companies.filter(company => (product === 'all' || company.mainProducts.includes(product)) &&
    [company.name, ...company.mainProducts].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const unassigned = projects.filter(project => !companyForProject(project, companies));
  return <section className="company-directory" aria-label="企业列表">
    <div className="company-toolbar">
      <label><span>查询企业</span><div className="company-search"><Search size={17} /><input aria-label="查询企业" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索公司名称或主营产品" /></div></label>
      <label><span>主营产品</span><select aria-label="按主营产品筛选企业" value={product} onChange={event => setProduct(event.target.value)}><option value="all">全部产品</option>{products.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <button className="button secondary" onClick={onAll}><FolderOpen size={16} />全部专利（{projects.length}）</button>
    </div>
    <div className="project-results"><span>共 {companies.length} 家企业，当前显示 {visible.length} 家</span>{(query || product !== 'all') && <button className="text-button" onClick={() => { setQuery(''); setProduct('all'); }}>重置筛选</button>}</div>
    <div className="company-grid">{visible.map(company => {
      const patents = projects.filter(project => companyForProject(project, companies)?.id === company.id);
      return <article key={company.id} className="company-card">
        <div className="company-card-heading"><span className="company-icon"><Building2 size={24} /></span><div className="company-card-actions">
          <button className="icon-button" aria-label={`编辑企业${company.name}`} onClick={() => onEdit(company)}><PenLine size={17} /></button>
          <button className="icon-button danger" aria-label={`删除企业${company.name}`} onClick={() => onDelete(company)}><Trash2 size={17} /></button>
        </div></div>
        <button className="company-open" onClick={() => onOpen(company)}><h2>{company.name}</h2><span>查看该企业全部专利<ArrowRight size={17} /></span></button>
        <p className="company-product-label">主营产品</p><div className="company-products">{company.mainProducts.length ? company.mainProducts.map(value => <span key={value}>{value}</span>) : <small>待补充主营产品</small>}</div>
        <div className="company-patent-counts"><span><strong>{patents.length}</strong> 项专利</span><span>{patents.filter(isGeneratedPatent).length} 项已生成</span>{patents.some(project => project.productWorkflow?.generation?.state === 'running') && <span className="company-running">正在生成</span>}</div>
      </article>;
    })}</div>
    {!visible.length && <div className="empty-state"><Building2 size={34} /><h3>{query || product !== 'all' ? '没有找到相关企业' : '从新增第一家企业开始'}</h3><p>先建立企业资料，再进入企业管理专利。</p><button className="button secondary" onClick={onCreate}>新增企业</button></div>}
    {!!unassigned.length && <button className="company-unassigned" onClick={onUnassigned}><FolderOpen size={19} /><span>未归属企业的专利 <strong>{unassigned.length}</strong><small>原有专利保留在这里，可在编辑时重新归属企业。</small></span><ArrowRight size={17} /></button>}
  </section>;
}
