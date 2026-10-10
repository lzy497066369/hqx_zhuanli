import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, Save } from 'lucide-react';
import type { Project } from '../../data';
import { inventionSource, makeInventionMaterials, validateInventionMaterials } from './invention';
import type { InventionFacts } from './invention';
import { createInventionWordBlob, inventionWordFilename } from './wordExport';
import './invention.css';

const emptyFacts: InventionFacts = {
  technicalField: '', background: '', problem: '', solution: '', steps: '', limitations: '', effects: '', embodiment: '', confirmed: false,
};
type TextKey = Exclude<keyof InventionFacts, 'confirmed'>;
type Step = 1 | 2 | 3 | 4;
const fieldMeta: Record<TextKey, { label: string; placeholder: string; rows: number }> = {
  technicalField: { label: '技术领域', placeholder: '具体技术领域', rows: 3 },
  background: { label: '背景技术', placeholder: '已核实的现有技术及出处、实际存在的问题', rows: 4 },
  problem: { label: '解决的技术问题', placeholder: '需要解决的具体问题', rows: 3 },
  solution: { label: '技术方案', placeholder: '产品组成或工艺方案的总体描述', rows: 4 },
  steps: { label: '工艺或技术步骤', placeholder: '每行一个步骤，按实施顺序填写；不要填写 S1 编号', rows: 5 },
  limitations: { label: '从属限定', placeholder: '每行一个已确认的参数、配比或步骤限定；可在行首写“根据权利要求N所述”指定上位项；可留空', rows: 4 },
  effects: { label: '有益效果及依据', placeholder: '仅填写有技术事实或试验依据支持的作用', rows: 4 },
  embodiment: { label: '具体实施方式', placeholder: '实际用料、参数和操作过程；多段可换行', rows: 6 },
};
const required = (facts: InventionFacts, keys: TextKey[]) => keys.every(key => facts[key].trim());

export function InventionWorkspace({ project, onSave, onBack }: {
  project: Project; onSave: (project: Project) => void; onBack: () => void;
}) {
  const [facts, setFacts] = useState<InventionFacts>(project.inventionFacts || emptyFacts);
  const [projectName, setProjectName] = useState(project.name === '未命名发明专利' ? '' : project.name);
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const current = !!project.inventionMaterials && !!facts.confirmed &&
    project.inventionMaterials.source === inventionSource(projectName, facts);
  const [activeStep, setActiveStep] = useState<Step>(current ? 4 : 1);
  const stepOneComplete = required(facts, ['technicalField', 'background', 'problem', 'solution']);
  const stepTwoComplete = !!facts.steps.trim();
  const stepThreeComplete = required(facts, ['effects', 'embodiment']) && facts.confirmed;
  const change = (key: TextKey | 'confirmed', value: string | boolean) => {
    setFacts(previous => ({ ...previous, [key]: value, confirmed: key === 'confirmed' ? value : false } as InventionFacts));
    setNotice('');
  };
  const saveDraft = (nextFacts = facts) => onSave({ ...project, name: projectName.trim() || project.name, inventionFacts: nextFacts, updatedAt: new Date().toISOString() });
  const advance = (step: 1 | 2 | 3) => {
    const valid = step === 1 ? stepOneComplete : step === 2 ? stepTwoComplete : stepThreeComplete;
    if (!valid) { setNotice(step === 1 ? '请先补齐基础技术资料。' : step === 2 ? '请至少填写一个实际工艺或技术步骤。' : '请补齐有益效果、实施方式并确认技术事实。'); return; }
    saveDraft(); setActiveStep((step + 1) as Step); setNotice('');
  };
  const generate = (event: FormEvent) => {
    event.preventDefault();
    try {
      const name = projectName.trim();
      const materials = makeInventionMaterials(name, facts);
      onSave({ ...project, name, inventionFacts: facts, inventionMaterials: materials, updatedAt: new Date().toISOString() });
      setActiveStep(4);
      setNotice('申请材料已生成并保存在此浏览器。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '生成失败。'); }
  };
  const exportWord = async () => {
    setExporting(true);
    try {
      validateInventionMaterials(projectName, facts, project.inventionMaterials);
      const blob = await createInventionWordBlob({ ...project, name: projectName, inventionFacts: facts });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = inventionWordFilename(projectName); anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Word 文件已导出。');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Word 导出失败。'); }
    finally { setExporting(false); }
  };
  const canOpen = (step: Step) => step === 1 || (step === 2 && stepOneComplete) || (step === 3 && stepOneComplete && stepTwoComplete) || (step === 4 && current);
  const stepStatus = (step: Step) => step === 1 ? stepOneComplete : step === 2 ? stepTwoComplete : step === 3 ? stepThreeComplete : current;
  const renderField = (key: TextKey, requiredField = true) => {
    const meta = fieldMeta[key];
    return <label className="invention-field" key={key} htmlFor={`invention-${key}`}>
      <span>{meta.label}{requiredField && <span aria-hidden="true"> *</span>}</span>
      <textarea id={`invention-${key}`} required={requiredField} rows={meta.rows} placeholder={meta.placeholder} value={facts[key]} onChange={event => change(key, event.target.value)} />
    </label>;
  };
  return <div className="invention-workspace">
    <button className="button secondary" onClick={onBack}><ArrowLeft size={16} /> 返回项目</button>
    <header><p className="eyebrow">INVENTION PATENT</p><h1>{projectName || '新建发明专利'}</h1><p>按四个步骤整理发明专利申请材料</p></header>
    <ol className="invention-workflow" aria-label="发明专利创作步骤">
      {([[1, '确定名称', '基础技术资料'], [2, '确认技术方案', '工艺与限定'], [3, '核对实施依据', '效果与事实'], [4, '申请材料', '生成与导出']] as [Step, string, string][]).map(([step, title, detail]) => <li key={step} className={stepStatus(step) && step !== activeStep ? 'done' : ''} aria-current={activeStep === step ? 'step' : undefined}>
        <button type="button" disabled={!canOpen(step)} onClick={() => { setActiveStep(step); setNotice(''); }}><span>{stepStatus(step) && step !== activeStep ? <Check size={14} /> : `0${step}`}</span><strong>{title}</strong><small>{stepStatus(step) ? '已完成' : detail}</small></button>
      </li>)}
    </ol>
    {notice && <p role="status" className="invention-notice">{notice}</p>}
    {activeStep < 4 && <form onSubmit={event => { event.preventDefault(); if (activeStep === 3) generate(event); else advance(activeStep as 1 | 2); }}>
      {activeStep === 1 && <section className="invention-step"><h2>确定名称与基础技术资料</h2><p className="invention-step-intro">先明确发明所属领域、现有技术和要解决的问题，再形成技术方案概述。</p><label className="invention-field" htmlFor="invention-name"><span>发明名称 *</span><input id="invention-name" required maxLength={100} value={projectName} placeholder="例如：一种服装面料的生产工艺" onChange={event => { setProjectName(event.target.value); setNotice(''); }} /></label>{(['technicalField', 'background', 'problem', 'solution'] as TextKey[]).map(key => renderField(key))}<div className="invention-actions"><button className="button primary" type="submit">下一步：确认技术方案 <ArrowRight size={16} /></button></div></section>}
      {activeStep === 2 && <section className="invention-step"><h2>确认工艺与技术方案</h2><p className="invention-step-intro">按照真实实施顺序拆分步骤；从属限定只填写已经核对的参数、配比或附加步骤。</p>{renderField('steps')}{renderField('limitations', false)}<div className="invention-actions"><button className="button secondary" type="button" onClick={() => setActiveStep(1)}>上一步</button><button className="button primary" type="submit">下一步：核对实施依据 <ArrowRight size={16} /></button></div></section>}
      {activeStep === 3 && <section className="invention-step"><h2>核对效果与实施依据</h2><p className="invention-step-intro">效果必须能由已填写的技术事实或试验依据支持，实施方式应足以说明如何完成本发明。</p>{renderField('effects')}{renderField('embodiment')}<label className="invention-confirm"><input type="checkbox" checked={facts.confirmed} onChange={event => change('confirmed', event.target.checked)} />已核对以上技术事实、步骤、参数和效果依据</label><div className="invention-actions"><button className="button secondary" type="button" onClick={() => setActiveStep(2)}>上一步</button><button className="button primary" type="submit"><Save size={16} /> 生成申请材料</button></div></section>}
    </form>}
    {activeStep === 4 && <section className="invention-preview"><div className="invention-materials-head"><div><h2>发明专利申请材料</h2><p>待专业审核的初稿，内容来自已确认技术事实。</p></div><div className="invention-actions"><button className="button secondary" type="button" onClick={() => setActiveStep(3)}>返回核对</button><button className="button secondary" type="button" disabled={!current || exporting} onClick={exportWord}><Download size={16} /> 下载 Word</button></div></div>{current ? <>
      <h3>说明书摘要</h3><p>{project.inventionMaterials!.abstract}</p>
      <h3>权利要求书</h3>{project.inventionMaterials!.claims.map((claim, index) => <p key={index}>{claim}</p>)}
      <h3>说明书</h3>{project.inventionMaterials!.sections.map(section => <div key={section.title}><h4>{section.title}</h4>{section.paragraphs.map((text, index) => <p key={index}>{text}</p>)}</div>)}
    </> : <div className="invention-empty"><strong>申请材料尚未生成</strong><p>请完成前三步并确认技术事实，系统才会生成可预览和导出的材料。</p><button className="button primary" type="button" onClick={() => setActiveStep(3)}>返回第三步</button></div>}</section>}
  </div>;
}
