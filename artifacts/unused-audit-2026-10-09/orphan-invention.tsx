// Audit-only harness. This is deliberately outside the application entry graph.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InventionWorkspace } from '../../src/features/invention/InventionWorkspace';
import type { Project } from '../../src/data';
import '../../src/index.css';
import '../../src/App.css';
function IsolatedPreview() {
  const [project, setProject] = useState<Project>({id:'audit-orphan-preview', category:'invention',name:'一种服装面料的生产工艺',owner:'审计演示',description:'仅用于代码审计截图',status:'draft',updatedAt:'2026-10-09T02:00:00Z'});
  return <><div style={{padding:'14px 28px',background:'#fff1f0',color:'#a51d25',textAlign:'center',fontWeight:600}}>审计隔离预览：以下是旧组件的真实渲染，不属于当前网站导航，也没有重新接入应用。</div><InventionWorkspace project={project} onSave={setProject} onBack={()=>{}} /></>;
}
createRoot(document.getElementById('root')!).render(<IsolatedPreview />);
