import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Box,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Code2,
  FileCheck2,
  FileText,
  FolderClosed,
  FolderOpen,
  LayoutDashboard,
  LayoutTemplate,
  Lightbulb,
  Menu,
  Plus,
  PenLine,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  categories,
  makeDocument,
  hasConfirmedUtilityStructure,
} from "./data";
import type { CategoryId, Project } from "./data";
import { loadProjectsAsync, saveProjectsAsync } from "./storage/projectStorage";
import { loadCompaniesAsync, saveCompaniesAsync } from './storage/companyStorage';
import { CompanyDirectory, CompanyEditor } from './features/projects/CompanyDirectory';
import { companyForProject, companyNameKey } from './features/projects/company';
import type { Company } from './features/projects/company';
import { loadMaterialsAsync, saveMaterialsAsync } from './storage/materialStorage';
import type { Material } from './storage/materialStorage';
import { getStorageDriver, storageError } from './storage/storageApi';
import { newId } from "./storage/id";
import { Illustration } from "./components/Illustration";
import { UtilityNaming } from "./features/utility/UtilityNaming";
import { ProductWorkflowWorkspace } from './features/product/ProductWorkflowWorkspace';
import { ProjectGenerationProgress } from './features/product/ProjectGenerationProgress';
import { createProductWorkflow, isProductWorkflowComplete, namingFingerprint } from './features/product/productWorkflow';
import type { ProductWorkflow } from './features/product/productWorkflow';
import { canExportPatent, downloadExport, exportProjectPatent } from './features/export/patentExport';
import type { PatentExportFormat } from './features/export/patentExport';
import { validateInventionMaterials } from './features/invention/invention';
import type { NamingRecord } from "./features/utility/naming";
import { ProjectEditor } from './features/projects/ProjectEditor';
import { baseProductName, filingStatuses, isGeneratedPatent } from './features/projects/projectManagement';
import { FilingStatusButtons } from './features/projects/FilingStatusButtons';
import type { FilingStatus } from './features/projects/projectManagement';
import { Modal } from "./components/Modal";
import "./App.css";
import { authRequest } from './features/auth/authApi';
import type { AuthUser } from './features/auth/authApi';

type Page = "dashboard" | "projects" | "materials" | "templates" | "invention";
const pages: Record<Page, string> = {
  dashboard: "工作台",
  projects: "项目管理",
  materials: "资料库",
  templates: "模板中心",
  invention: '发明专利 · 申请材料',
};
const categoryIcons = {
  invention: Lightbulb,
  utility: Box,
  design: Sparkles,
  software: Code2,
};
function getPage(): Page {
  const value = location.hash.slice(1).split("/")[0];
  if (value === 'utility') return 'projects';
  return Object.hasOwn(pages, value) ? (value as Page) : "dashboard";
}
function App({ user = null, workspaceManager, workspaceName }: { user?: AuthUser | null; workspaceManager?: ReactNode; workspaceName?: string }) {
  const [page, setPage] = useState<Page>(getPage);
  const [projects, setProjects] = useState<Project[]>([]);
  const [companyList, setCompanyList] = useState<Company[]>([]);
  const [companyEditor, setCompanyEditor] = useState<Partial<Company> | null>(null);
  const [deletingCompany, setDeletingCompany] = useState<Company | null>(null);
  const [companyScope, setCompanyScope] = useState(() => getPage() === 'projects' ? location.hash.split('/')[1] || '' : '');
  const directory = page === 'projects' && !companyScope;
  const selectedCompany = companyList.find(company => company.id === companyScope);
  const companyDisplayName = (project: Project) => companyForProject(project, companyList)?.name || project.owner;
  const [storageReady, setStorageReady] = useState(false);
  const [storageIssue, setStorageIssue] = useState('');
  const [storageMode, setStorageMode] = useState<'mysql' | 'indexeddb'>('mysql');
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [productFilter, setProductFilter] = useState('all');
  const [filingFilter, setFilingFilter] = useState('all');
  const [mobileNav, setMobileNav] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [profile, setProfile] = useState(false);
  const [toast, setToast] = useState("");
  const [workflowProjectId, setWorkflowProjectId] = useState<string | null>(null);
  const inventionProject = projects.find(p => p.category === 'invention' && p.id === location.hash.split('/')[1]);
  const [inventionStage, setInventionStage] = useState<"naming" | "workspace">("naming");
  const [workflowSessions, setWorkflowSessions] = useState<string[]>([]);
  const activeWorkflowProject = projects.find(project => project.id === workflowProjectId)
    || (page === 'invention' && inventionStage === 'workspace' ? inventionProject : undefined);
  const sessionKey = (project: Project) => `${project.id}:${namingFingerprint(project)}`;
  const activeSession = activeWorkflowProject && (activeWorkflowProject.category === 'utility' || activeWorkflowProject.naming) ? sessionKey(activeWorkflowProject) : undefined;
  useEffect(() => {
    if (activeSession) {
      // oxlint-disable-next-line react/set-state-in-effect -- Keep visited project sessions alive across navigation.
      setWorkflowSessions(current => current.includes(activeSession) ? current : [...current, activeSession]);
    }
  }, [activeSession]);
  const [editor, setEditor] = useState<Partial<Project> | null>(null);
  const [preview, setPreview] = useState<Project | null>(null);
  const [exporting, setExporting] = useState<PatentExportFormat | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const upload = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Load storage before enabling writes; a connection failure cannot overwrite data.
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadProjectsAsync().then(async list => ({ list, companies: await loadCompaniesAsync(list) })), loadMaterialsAsync(), getStorageDriver()]).then(([loaded, files, mode]) => {
      if (cancelled) return;
      let list = loaded.list;
      setCompanyList(loaded.companies);
      list = list.map(project => ({ ...project, companyId: project.companyId || companyForProject(project, loaded.companies)?.id }));
      // Requests belong to this browser session; a reload cannot leave a stale running badge.
      list = list.map(project => project.productWorkflow?.generation?.state === 'running' ? {
        ...project, productWorkflow: { ...project.productWorkflow, generation: { ...project.productWorkflow.generation,
          state: 'cancelled' as const, label: '生成已中断', detail: '页面已重新加载，本次生成已中断。已有成果保留，请进入项目继续。', updatedAt: new Date().toISOString() } },
      } : project);
      setProjects(list);
      setMaterials(files);
      setStorageMode(mode);
      const hashId = location.hash.split("/")[1];
      if (location.hash.startsWith('#utility')) {
        const target = list.find(project => project.id === hashId && project.category === 'utility');
        if (target?.productWorkflow) setWorkflowProjectId(target.id);
        else setEditor(target || { category: 'utility', name: '', owner: '', description: '' });
        history.replaceState(null, '', '#projects/all'); setCompanyScope('all');
      }
      if (list.find(p => p.category === "invention" && p.id === hashId)?.naming?.confirmed) {
        // oxlint-disable-next-line react/set-state-in-effect -- Hydrate navigation state once storage is ready.
        setInventionStage("workspace");
      }
      // oxlint-disable-next-line react/set-state-in-effect -- Hydrate navigation state once storage is ready.
      setStorageReady(true);
    }).catch(error => {
      if (!cancelled) setStorageIssue(error instanceof Error ? error.message : '项目加载失败，请检查存储服务。');
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = getPage();
      setPage(next);
      setCompanyScope(next === 'projects' ? location.hash.split('/')[1] || '' : '');
      setWorkflowProjectId(null);
      if (location.hash.startsWith('#utility')) {
        const target = projects.find(project => project.id === location.hash.split('/')[1] && project.category === 'utility');
        if (target?.productWorkflow) setWorkflowProjectId(target.id);
        else setEditor(target || { category: 'utility', name: '', owner: '', description: '' });
        history.replaceState(null, '', '#projects/all'); setCompanyScope('all');
      }
      if (next === "invention") {
        const id = location.hash.split("/")[1];
        if (!id || id !== inventionProject?.id) setInventionStage(projects.find(project => project.id === id)?.productWorkflow ? 'workspace' : 'naming');
      }
      setMobileNav(false);
      mainRef.current?.focus();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [projects, inventionProject?.id]);
  // Storage is external; a failed write must surface a recoverable notice.
  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    saveProjectsAsync(projects).then(ok => {
      // oxlint-disable-next-line react/set-state-in-effect -- Report failed external storage writes.
      if (!cancelled && !ok) setStorageIssue(storageError());
    });
    return () => { cancelled = true; };
  }, [projects, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    void saveCompaniesAsync(companyList).then(ok => { if (!cancelled && !ok) setStorageIssue(storageError()); });
    return () => { cancelled = true; };
  }, [companyList, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    saveMaterialsAsync(materials).then(ok => {
      if (!cancelled && !ok) setStorageIssue(storageError());
    });
    return () => { cancelled = true; };
  }, [materials, storageReady]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4200);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const navigate = (next: Page) => {
    location.hash = next;
    setMobileNav(false);
  };
  const openCompanyScope = (scope = '') => {
    clearFilters(); setCompanyScope(scope); setPage('projects');
    // oxlint-disable-next-line react/immutability -- Hash navigation changes the browser route.
    location.hash = scope ? `projects/${scope}` : 'projects';
  };
  const saveCompany = (company: Company) => {
    setCompanyList(current => [company, ...current.filter(item => item.id !== company.id)]);
    setCompanyEditor(null); openCompanyScope();
    setToast(companyEditor?.id ? '企业资料已更新' : '企业已创建，点击企业进入专利管理');
  };
  const create = (category: CategoryId = 'utility', name = '') => {
    setEditor({ category, name, owner: selectedCompany?.name || '', companyId: selectedCompany?.id,
      baseProductName: selectedCompany?.mainProducts.length === 1 ? selectedCompany.mainProducts[0] : '', description: '' });
  };
  const saveInventionName = (naming: NamingRecord) => {
    if (!inventionProject) return;
    const updated: Project = {
      ...inventionProject,
      name: naming.selectedName,
      owner: naming.profile.company.trim(),
      description: `产品名称：${naming.profile.business.trim()}\n技术特征：${naming.profile.features.trim()}`,
      naming,
      updatedAt: new Date().toISOString(),
    };
    updated.productWorkflow = inventionProject.productWorkflow?.sourceFingerprint === namingFingerprint(updated) ? inventionProject.productWorkflow : createProductWorkflow(updated);
    setProjects(list => list.map(item => item.id === updated.id ? updated : item));
    setInventionStage("workspace");
    setToast("名称已确认，正在保存并进入产品创作流程");
  };
  const saveProductWorkflow = (projectId: string, workflow: ProductWorkflow) => {
    const apply = (item: Project): Project => {
      if (item.id !== projectId || workflow.sourceFingerprint !== namingFingerprint(item)) return item;
      return { ...item, productWorkflow: workflow,
        filingStatus: isProductWorkflowComplete(workflow) ? item.filingStatus || 'not_submitted' : undefined,
        status: isProductWorkflowComplete(workflow) ? 'ready' : 'draft', updatedAt: workflow.updatedAt };
    };
    setProjects(list => list.map(apply));
    setPreview(current => current ? apply(current) : current);
  };
  const openProject = (project: Project) => {
    if (project.productWorkflow && (project.category === 'utility' || project.category === 'invention')) {
      setWorkflowProjectId(project.id);
      setPreview(null);
    } else setPreview(project);
  };
  const saveProject = (value: Partial<Project>, start: boolean) => {
    const current = projects.find(item => item.id === value.id);
    const project: Project = {
      ...current, ...value,
      id: value.id || newId(), name: value.name!, category: value.category!, owner: value.owner || '',
      description: value.description || '', status: start ? 'draft' : current?.status || 'draft', updatedAt: new Date().toISOString(),
    };
    let company = companyList.find(item => item.id === project.companyId);
    if (!company && project.owner.trim() && !project.companyId) {
      company = companyList.find(item => companyNameKey(item.name) === companyNameKey(project.owner));
      if (!company) {
        company = { id: newId(), name: project.owner.trim(), mainProducts: project.baseProductName ? [project.baseProductName] : [], updatedAt: project.updatedAt };
        setCompanyList(list => [...list, company!]);
      }
      project.companyId = company.id;
    }
    if (company) project.owner = company.name;
    if (start) {
      project.productWorkflow = createProductWorkflow(project);
      project.utilityDrawing = undefined; project.utilityMaterials = undefined;
      project.inventionFacts = undefined; project.inventionMaterials = undefined;
      project.filingStatus = undefined;
    } else if (value.category !== editor?.category) {
      project.naming = undefined; project.productWorkflow = undefined; project.filingStatus = undefined;
      project.utilityDrawing = undefined; project.utilityMaterials = undefined;
      project.inventionFacts = undefined; project.inventionMaterials = undefined;
    }
    setProjects(list => [project, ...list.filter(item => item.id !== project.id)]);
    if (start) setWorkflowSessions(current => [...current.filter(key => !key.startsWith(`${project.id}:`)), sessionKey(project)]);
    setEditor(null);
    if (start || project.category === 'utility' || project.category === 'invention') {
      setPreview(null); setWorkflowProjectId(null);
      clearFilters();
      openCompanyScope(selectedCompany?.id || 'all');
      setToast(start ? '项目已开始生成，可以继续新建项目' : '项目已更新');
    } else { setPreview(project); setToast('项目草稿已更新，正在保存'); }
  };
  const changeFilingStatus = (project: Project, filingStatus: FilingStatus) => {
    if (!isGeneratedPatent(project)) return;
    const update = (item: Project) => item.id === project.id && isGeneratedPatent(item)
      ? { ...item, filingStatus, updatedAt: new Date().toISOString() } : item;
    setProjects(list => list.map(update));
    setPreview(current => current ? update(current) : current);
    setToast(`申报状态已切换为${filingStatuses[filingStatus]}`);
  };
  const download = async (project: Project, format: PatentExportFormat = 'word') => {
    if (exporting) return;
    if (project.productWorkflow || project.category === 'invention' || project.category === 'utility') {
      setExporting(format);
      const label = format === 'pdf' ? 'PDF' : 'Word';
      try {
        downloadExport(await exportProjectPatent(structuredClone(project), format));
        setToast(`${label} 申请材料初稿已导出，请核对后进行专业审核`);
      } catch (error) { setToast(error instanceof Error ? error.message : `${label} 导出失败`); }
      finally { setExporting(null); }
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([makeDocument(project)], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[/\\:*?"<>|]/g, '-')}-材料模板.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast('材料已导出，请核对后进行专业审核');
    } catch (error) { setToast(error instanceof Error ? error.message : '材料导出失败'); }
  };
  const clearFilters = () => {
    setQuery(''); setFilter('all'); setCategoryFilter('all'); setCompanyFilter('all'); setProductFilter('all'); setFilingFilter('all');
  };
  const hasFilters = !!query || [filter, categoryFilter, companyFilter, productFilter, filingFilter].some(value => value !== 'all');
  const scopedProjects = companyScope === 'all' || !companyScope ? projects : companyScope === 'unassigned'
    ? projects.filter(project => !companyForProject(project, companyList))
    : projects.filter(project => companyForProject(project, companyList)?.id === companyScope);
  const companies = [...new Set(scopedProjects.map(companyDisplayName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const products = [...new Set(scopedProjects.map(baseProductName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const visibleProjects = page === 'dashboard' ? projects : scopedProjects.filter(project =>
    (filter === 'all' || project.status === filter) &&
    (categoryFilter === 'all' || project.category === categoryFilter) &&
    (companyFilter === 'all' || companyDisplayName(project) === companyFilter) &&
    (productFilter === 'all' || baseProductName(project) === productFilter) &&
    (filingFilter === 'all' || (isGeneratedPatent(project) && (project.filingStatus || 'not_submitted') === filingFilter)) &&
    [project.name, companyDisplayName(project), baseProductName(project), project.naming?.selectedName,
      categories.find(category => category.id === project.category)?.name].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const navItems = [
    { id: "dashboard" as const, icon: LayoutDashboard },
    { id: "projects" as const, icon: FolderClosed },
    { id: "materials" as const, icon: BookOpen },
  ];
  const stats = [
    {
      label: "全部项目",
      value: projects.length,
      icon: FolderOpen,
      detail: "每一份创意，都值得记录",
      filter: "all",
    },
    {
      label: "编辑中的草稿",
      value: projects.filter((p) => p.status === "draft").length,
      icon: FileText,
      detail: "继续完善你的创新想法",
      filter: "draft",
    },
    {
      label: "已整理材料",
      value: projects.filter((p) => p.status === "ready").length,
      icon: FileCheck2,
      detail: "材料已归档，随时可查阅",
      filter: "ready",
    },
    {
      label: "知识产权类型",
      value: "04",
      icon: LayoutTemplate,
      detail: "覆盖四类创新成果",
      filter: "types",
    },
  ];
  const projectTable = (
    <div className="project-table-wrap">
      <table>
        <thead>
          <tr>
            <th>项目名称</th>
            <th className="project-company-column">公司</th>
            <th className="project-product-column">基础产品名</th>
            <th className="project-type-column">类型</th>
            <th>状态</th>
            <th className="project-date-column">最近更新</th>
            <th>
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleProjects
            .slice(0, page === "dashboard" ? 4 : undefined)
            .map((p) => {
              const c = categories.find((c) => c.id === p.category)!,
                Icon = categoryIcons[p.category];
              return (
                <tr key={p.id}>
                  <td>
                    <button
                      className="project-name"
                      onClick={() => openProject(p)}
                    >
                      <span className={`file-icon ${c.color}`}>
                        <Icon size={19} />
                      </span>
                      <span>
                        {p.name}
                        {p.demo && <small>示例项目</small>}
                        <small className="project-mobile-meta">{companyDisplayName(p) || '未填写公司'} · {baseProductName(p) || '未填写产品'}</small>
                      </span>
                    </button>
                    <ProjectGenerationProgress project={p} />
                  </td>
                  <td className="project-company-column">{companyDisplayName(p) || '—'}</td>
                  <td className="project-product-column"><span className="product-category-tag">{baseProductName(p) || '—'}</span></td>
                  <td className="project-type-column">
                    <span className="type-label">{c.name}</span>
                  </td>
                  <td>
                    <span className={`status ${isGeneratedPatent(p) ? 'ready' : p.status}`}>
                      <span />
                      {isGeneratedPatent(p) ? '生成完毕' : p.status === "draft" ? "草稿" : "已整理"}
                    </span>
                    <FilingStatusButtons project={p} onChange={changeFilingStatus} />
                  </td>
                  <td className="date project-date-column">
                    {new Date(p.updatedAt)
                      .toLocaleDateString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                      })
                      .replaceAll("/", "-")}
                  </td>
                  <td className="project-actions-cell"><div className="project-row-actions">
                    <button
                      className="icon-button"
                      aria-label={`查看${p.name}`}
                      onClick={() => setPreview(p)}
                    >
                      <ChevronRight size={17} />
                    </button>
                    <button className="icon-button" aria-label={`编辑${p.name}`} onClick={() => setEditor(p)}><PenLine size={16} /></button>
                    <button className="icon-button danger" aria-label={`删除${p.name}`} onClick={() => setDeleting(p)}><Trash2 size={16} /></button>
                  </div></td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {visibleProjects.length === 0 && (
        <div className="empty-state">
          <Search size={30} />
          <h3>
            {hasFilters
              ? "没有找到相关项目"
              : "从第一份创意开始"}
          </h3>
          <p>
            {hasFilters
              ? "试试其他关键词，或切换项目筛选条件。"
              : "选择一种知识产权类型，创建你的第一个项目。"}
          </p>
          <button
            className="button secondary"
            onClick={() => {
              if (hasFilters) clearFilters(); else create();
            }}
          >
            {hasFilters ? "清除筛选" : "新建项目"}
          </button>
        </div>
      )}
    </div>
  );
  if (!storageReady) {
    return (
      <div className="app-shell">
        <div className="empty-state">
          <h2>{storageIssue ? '项目加载失败' : '正在加载项目…'}</h2>
          {storageIssue && <><p role="alert">{storageIssue}</p><button className="button primary" onClick={() => location.reload()}>重新加载</button></>}
        </div>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        跳转到主要内容
      </a>
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <a href="#dashboard" className="brand">
          <span className="brand-mark">
            <Box size={26} />
          </span>
          <span>
            知创工坊<small>IDEAS INTO ASSETS</small>
          </span>
        </a>
        {workspaceManager}
        <div className="nav-label">工作空间</div>
        <nav aria-label="主要导航">
          {user?.role === 'admin' && <a href="#admin" className="nav-item"><ShieldCheck size={19} /><span>管理控制台</span></a>}
          {navItems.map(({ id, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={page === id ? "page" : undefined}
              className={`nav-item ${page === id ? "active" : ""}`}
            >
              <Icon size={19} />
              <span>{pages[id]}</span>
              {id === "projects" && (
                <span className="nav-count">{companyList.length}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="nav-label tools-label">创作工具</div>
        <nav aria-label="创作工具">
          <a
            href="#templates"
            className={`nav-item ${page === "templates" ? "active" : ""}`}
            aria-current={page === "templates" ? "page" : undefined}
          >
            <LayoutTemplate size={19} />
            <span>模板中心</span>
            <span className="small-new">NEW</span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-version">
            <span className="online-dot" />
            本地工作空间 <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span>{workspaceName || '工作空间'}</span>
            <ChevronRight size={14} />
            <strong>{page === 'projects' && companyScope ? selectedCompany?.name || (companyScope === 'all' ? '全部专利' : '未归属企业的专利') : pages[page]}</strong>
          </div>
          <div className="header-actions">
            <label className="global-search">
              <Search size={16} />
              <input
                aria-label="搜索项目"
                placeholder="搜索你的项目…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (page !== "projects" || directory) { setCompanyScope('all'); location.hash = 'projects/all'; }
                }}
              />
              <kbd>⌕</kbd>
            </label>
            <div className="popover-anchor">
              <button
                className="icon-button notification-button"
                aria-label="通知"
                aria-expanded={notifications}
                onClick={() => {
                  setNotifications(!notifications);
                  setProfile(false);
                }}
              >
                <Bell size={19} />
                <span />
              </button>
              {notifications && (
                <div className="popover">
                  <strong>工作空间通知</strong>
                  <p>
                    欢迎来到知创工坊。四类材料模板已就绪，开始记录你的第一个创意吧。
                  </p>
                  <small>前端体验版 · 无云端消息</small>
                </div>
              )}
            </div>
            <span className="header-divider" />
            <div className="popover-anchor">
              <button
                className="avatar"
                aria-label="个人工作空间信息"
                aria-expanded={profile}
                onClick={() => {
                  setProfile(!profile);
                  setNotifications(false);
                }}
              >
                {user?.displayName.slice(0, 1) || '知'}
              </button>
              {profile && (
                <div className="popover">
                  <strong>{user?.displayName || '个人工作空间'}</strong>
                  {user && <p>@{user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}</p>}
                  <p>
                    {storageMode === 'mysql' ? '每个工作空间只属于你的账号，项目、草稿和资料按空间独立保存。' : '当前使用浏览器存储，请及时导出重要材料。'}
                  </p>
                  {user && <button className="account-logout" onClick={async () => {
                    if (!window.confirm('确认退出登录？请先确认当前修改已保存。')) return;
                    try { await authRequest('logout', {}); location.reload(); }
                    catch (error) { setToast(error instanceof Error ? error.message : '退出失败，请重试。'); }
                  }}>退出登录</button>}
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1}>
          {projects.filter(project => workflowSessions.includes(sessionKey(project)) || sessionKey(project) === activeSession).map(project => {
            const visible = sessionKey(project) === activeSession;
            return <Modal key={sessionKey(project)} title="项目详情与生成成果" className="project-workflow-modal" open={visible}
              onClose={() => { setWorkflowProjectId(null); if (page === 'invention') openCompanyScope(companyForProject(project, companyList)?.id || 'all'); }}>
              <ProductWorkflowWorkspace project={project} visible={visible} managed onSave={saveProductWorkflow}
                onBack={() => { setWorkflowProjectId(null); if (page === 'invention') openCompanyScope(companyForProject(project, companyList)?.id || 'all'); }} />
              <FilingStatusButtons project={project} onChange={changeFilingStatus} />
            </Modal>;
          })}
          {page === 'invention' && inventionProject ? (
            inventionStage === "workspace" && inventionProject.naming ? (
              null
            ) : (
              <UtilityNaming key={inventionProject.id} project={inventionProject} patentType="invention"
                onSave={saveInventionName} onOpenWorkspace={() => setInventionStage("workspace")} onBack={() => navigate("dashboard")} />
            )
          ) : page === "dashboard" ? (
            <>
              <section className="welcome">
                <div>
                  <div className="eyebrow">
                    <span /> 灵感有价值，创新有归属
                  </div>
                  <h1>
                    让每一个好想法，<span>有迹可循。</span>
                  </h1>
                  <p>从创意到成果，在这里开启你的知识产权创作之旅。</p>
                </div>
                <button className="button primary" onClick={() => create()}>
                  <Plus size={18} />
                  新建项目
                </button>
              </section>
              <section className="stats" aria-label="项目概览">
                {stats.map(
                  ({
                    label,
                    value,
                    icon: Icon,
                    detail,
                    filter: valueFilter,
                  }) => (
                    <button
                      className="stat"
                      key={label}
                      onClick={() => {
                        if (valueFilter === "types")
                          document.getElementById("creation")?.scrollIntoView({
                            behavior: matchMedia(
                              "(prefers-reduced-motion: reduce)",
                            ).matches
                              ? "instant"
                              : "smooth",
                          });
                        else {
                          setFilter(valueFilter);
                          setQuery("");
                          setCompanyScope('all'); location.hash = 'projects/all';
                        }
                      }}
                    >
                      <div className="stat-top">
                        <span>{label}</span>
                        <Icon size={18} />
                      </div>
                      <div className="stat-value">
                        {typeof value === "number"
                          ? String(value).padStart(2, "0")
                          : value}
                        <span>{valueFilter === "types" ? "类" : "个"}</span>
                      </div>
                      <p>{detail}</p>
                    </button>
                  ),
                )}
              </section>
              <section id="creation" className="creation-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      开始新的创作{" "}
                      <span className="section-tag">四大创作方向</span>
                    </h2>
                    <p>选择知识产权类型，将你的灵感转化为专业材料。</p>
                  </div>
                </div>
                <div className="category-grid">
                  {categories.map((c, i) => (
                    <article className={`category-card ${c.color}`} key={c.id}>
                      <div className="card-art" aria-hidden="true">
                        <span className="art-number">0{i + 1}</span>
                        <Illustration type={c.id} />
                        <span className="art-caption">{c.en}</span>
                      </div>
                      <div className="card-content">
                        <h3>{c.name}</h3>
                        <p>{c.description}</p>
                        <div className="tags">
                          {c.tags.map((t) => (
                            <span key={t}>{t}</span>
                          ))}
                        </div>
                        <button onClick={() => create(c.id)}>
                          开始创作
                          <ArrowRight size={17} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <div className="lower-grid">
                <section className="recent-section">
                  <div className="section-heading compact">
                    <h2>
                      最近项目{" "}
                      <span className="count-pill">{projects.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => {
                        setFilter("all");
                        setQuery("");
                        openCompanyScope('all');
                      }}
                    >
                      查看全部
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  {projectTable}
                </section>
              </div>
            </>
          ) : (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">YOUR CREATIVE WORKSPACE</div>
                  {page === 'projects' && companyScope && <button className="text-button company-back" onClick={() => openCompanyScope()}><ArrowLeft size={16} />返回企业列表</button>}
                  <h1>{page === 'projects' && companyScope ? selectedCompany ? `${selectedCompany.name}的专利` : companyScope === 'all' ? '全部专利' : companyScope === 'unassigned' ? '未归属企业的专利' : '企业不存在' : pages[page]}</h1>
                  <p>
                    {page === "projects"
                      ? directory ? '先建立企业资料，进入企业后管理该公司的全部专利。' : selectedCompany ? `主营产品：${selectedCompany.mainProducts.join('、') || '待补充'}` : '新建专利、选择问题、查看进度与管理申报状态。'
                      : page === "materials"
                        ? "整理你的参考文件，为下一次创作做好准备。"
                        : "从结构化模板开始，告别面对空白页的犹豫。"}
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() =>
                    page === "materials" ? upload.current?.click() : directory ? setCompanyEditor({}) : create()
                  }
                >
                  {page === "materials" ? (
                    <Upload size={18} />
                  ) : (
                    <Plus size={18} />
                  )}{" "}
                  {page === "materials" ? "选择本地文件" : directory ? "新增企业" : page === 'projects' ? '新增专利' : '新建项目'}
                </button>
              </section>
              {directory && <CompanyDirectory companies={companyList} projects={projects}
                onCreate={() => setCompanyEditor({})} onEdit={setCompanyEditor} onDelete={setDeletingCompany}
                onOpen={company => openCompanyScope(company.id)} onAll={() => openCompanyScope('all')} onUnassigned={() => openCompanyScope('unassigned')} />}
              {page === "projects" && companyScope && (
                <section className="projects-panel">
                  <div className="project-toolbar">
                    <div className="tabs">
                      {[
                        { id: "all", name: "全部项目" },
                        { id: "draft", name: "草稿" },
                        { id: "ready", name: "已整理" },
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          className={filter === tab.id ? "selected" : ""}
                          onClick={() => setFilter(tab.id)}
                        >
                          {tab.name}
                        </button>
                      ))}
                    </div>
                    <label className="filter-select">
                      <Settings2 size={16} />
                      <select
                        aria-label="按知识产权类型筛选"
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                      >
                        <option value="all">全部类型</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="project-search-filters">
                    <label className="project-search-field"><span>查询项目</span><div><Search size={16} /><input aria-label="查询项目" value={query} onChange={event => setQuery(event.target.value)} placeholder="项目名、专利名、公司或基础产品名" /></div></label>
                    <label><span>公司</span><select aria-label="按公司筛选" value={companyFilter} onChange={event => setCompanyFilter(event.target.value)}>
                      <option value="all">全部公司</option>{companies.map(company => <option value={company} key={company}>{company}</option>)}
                    </select></label>
                    <label><span>基础产品名</span><select aria-label="按基础产品名筛选" value={productFilter} onChange={event => setProductFilter(event.target.value)}>
                      <option value="all">全部产品</option>{products.map(product => <option value={product} key={product}>{product}</option>)}
                    </select></label>
                    <label><span>申报状态</span><select aria-label="按申报状态筛选" value={filingFilter} onChange={event => setFilingFilter(event.target.value)}>
                      <option value="all">全部申报状态</option>{Object.entries(filingStatuses).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
                    </select></label>
                  </div>
                  <div className="project-results"><span>共 {scopedProjects.length} 项专利，当前显示 {visibleProjects.length} 项</span>{hasFilters && <button className="text-button" onClick={clearFilters}>重置筛选</button>}</div>
                  {projectTable}
                </section>
              )}
              {page === "templates" && (
                <>
                  <div className="template-grid">
                    {categories.map((c) => {
                      const Icon = categoryIcons[c.id];
                      return (
                        <article
                          className={`template-card ${c.color}`}
                          key={c.id}
                        >
                          <div className="template-card-top">
                            <span className="file-icon">
                              <Icon size={24} />
                            </span>
                            <span className="section-tag">基础模板</span>
                          </div>
                          <h2>{c.name}材料模板</h2>
                          <p>{c.description}</p>
                          <ul>
                            {c.sections.map((s) => (
                              <li key={s}>
                                <Check size={15} />
                                {s}
                              </li>
                            ))}
                          </ul>
                          <button
                            className="button secondary"
                            onClick={() => create(c.id)}
                          >
                            使用此模板
                            <ArrowRight size={16} />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
              {page === "materials" && (
                <>
                  <input
                    ref={upload}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      setMaterials((m) => [
                        ...m,
                        ...files.map((file) => ({
                          id: newId(),
                          name: file.name,
                          size: file.size,
                          mimeType: file.type,
                          lastModified: file.lastModified,
                        })),
                      ]);
                      if (files.length)
                        setToast(
                          `已添加 ${files.length} 个文件的信息，正在保存；未上传文件内容`,
                        );
                      e.target.value = "";
                    }}
                  />
                  <div className="info-banner">
                    <ShieldCheck size={18} />
                    文件名称、大小等信息会保存，刷新后可恢复；文件内容不会上传。
                  </div>
                  {materials.length ? (
                    <div className="materials-list">
                      {materials.map((m) => (
                        <div className="material-row" key={m.id}>
                          <FileText size={24} />
                          <div>
                            <strong>{m.name}</strong>
                            <p>{(m.size / 1024).toFixed(1)} KB · 文件信息</p>
                          </div>
                          <button
                            className="icon-button"
                            aria-label={`移除${m.name}`}
                            onClick={() =>
                              setMaterials((list) =>
                                list.filter((x) => x.id !== m.id),
                              )
                            }
                          >
                            <X size={18} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state material-empty">
                      <span className="empty-icon">
                        <FolderOpen size={40} />
                      </span>
                      <h2>为你的创意，备好资料</h2>
                      <p>
                        选择技术文档、产品图片或软件说明，预览资料整理体验。
                      </p>
                      <button
                        className="button secondary"
                        onClick={() => upload.current?.click()}
                      >
                        <Upload size={17} />
                        选择本地文件
                      </button>
                      <small>文件不会被发送到服务器</small>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <footer>
            <span>© {new Date().getFullYear()} 知创工坊</span>
            <span>让创新更简单，让价值被看见。</span>
          </footer>
        </main>
      </div>
      {editor && <ProjectEditor initial={editor} companies={companyList} company={selectedCompany} onSave={saveProject} onClose={() => setEditor(null)} />}
      {companyEditor && <CompanyEditor initial={companyEditor} companies={companyList} onSave={saveCompany} onClose={() => setCompanyEditor(null)} />}
      {deletingCompany && <Modal title="删除企业？" onClose={() => setDeletingCompany(null)}>
        <p className="delete-message">删除“{deletingCompany.name}”的企业资料？已有专利会保留，并移到“未归属企业的专利”，可重新归属企业。</p>
        <div className="confirm-actions"><button className="button secondary" onClick={() => setDeletingCompany(null)}>保留企业</button>
          <button className="button danger-button" onClick={() => {
            setCompanyList(list => list.filter(company => company.id !== deletingCompany.id));
            setDeletingCompany(null); setToast('企业已删除，已有专利已保留');
          }}>确认删除企业</button></div>
      </Modal>}
      {preview && (
        <Modal title="项目材料预览" onClose={() => setPreview(null)} wide>
          <div className="preview-heading">
            <span
              className={`type-badge ${categories.find((c) => c.id === preview.category)?.color}`}
            >
              {categories.find((c) => c.id === preview.category)?.name}
            </span>
            {preview.demo && <span className="section-tag">示例项目</span>}
            <h3>{preview.name}</h3>
            <p>
              <Clock3 size={14} />
              更新于 {new Date(preview.updatedAt).toLocaleString("zh-CN")}
            </p>
          </div>
          <ProjectGenerationProgress project={preview} />
          <div className="project-preview-meta"><span>公司：{companyDisplayName(preview) || '未填写'}</span><span>基础产品名：{baseProductName(preview) || '未填写'}</span></div>
          <FilingStatusButtons project={preview} onChange={changeFilingStatus} />
          {preview.productWorkflow
            ? isProductWorkflowComplete(preview.productWorkflow) && preview.productWorkflow.sourceFingerprint === namingFingerprint(preview)
              ? <pre className="document-preview">{makeDocument(preview)}</pre>
              : <p className="document-preview" role="status">请进入产品预览与成品工作区，完成逻辑校验、彩色预览确认和黑白附图。</p>
            : preview.category === "utility" && !hasConfirmedUtilityStructure(preview)
            ? <p className="document-preview" role="status">Patent Structure Model 尚未确定；此阶段不生成或预览专利文案。</p>
            : preview.category === 'invention' && (() => { try { validateInventionMaterials(preview.name, preview.inventionFacts, preview.inventionMaterials); return false; } catch { return true; } })()
              ? <p className="document-preview" role="status">请先确认当前技术事实并生成发明申请材料。</p>
            : <pre className="document-preview">{makeDocument(preview)}</pre>}
          <div className="preview-actions">
            <button
              className="icon-button danger"
              aria-label="删除项目"
              onClick={() => setDeleting(preview)}
            >
              <Trash2 size={19} />
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setEditor(preview);
                setPreview(null);
              }}
            >
              编辑项目
            </button>
            {preview.productWorkflow && <button className="button secondary" onClick={() => openProject(preview)}><PenLine size={16} />查看生成成果</button>}
            <button
              className="button secondary"
              onClick={() => {
                const updated = {
                  ...preview,
                  status:
                    preview.status === "ready"
                      ? ("draft" as const)
                      : ("ready" as const),
                  updatedAt: new Date().toISOString(),
                };
                setProjects((list) =>
                  list.map((p) => (p.id === updated.id ? updated : p)),
                );
                setPreview(updated);
                setToast(
                  updated.status === "ready"
                    ? "已标记为材料已整理（不代表审核通过）"
                    : "已移回草稿",
                );
              }}
            >
              <CheckCheck size={16} />
              {preview.status === "ready" ? "移回草稿" : "标记已整理"}
            </button>
            <button
              className="button primary"
              onClick={() => download(preview)}
              disabled={!!exporting || ((preview.productWorkflow || preview.category === 'utility' || preview.category === 'invention') && !canExportPatent(preview))}
            >
              <ArrowDownToLine size={16} />
              {exporting === 'word' ? '正在打包 Word…' : preview.productWorkflow || preview.category === 'invention' || preview.category === 'utility' ? '下载 Word' : '导出模板'}
            </button>
            {(preview.productWorkflow || preview.category === 'invention' || preview.category === 'utility') && <button
              className="button secondary" onClick={() => void download(preview, 'pdf')} disabled={!!exporting || !canExportPatent(preview)}
            ><ArrowDownToLine size={16} />{exporting === 'pdf' ? '正在生成 PDF…' : '下载 PDF'}</button>}
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="删除这个项目？" onClose={() => setDeleting(null)}>
          <p className="delete-message">
            “{deleting.name}”将从工作空间移除，此操作无法撤销。
          </p>
          <div className="confirm-actions">
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
            >
              保留项目
            </button>
            <button
              className="button danger-button"
              onClick={() => {
                setProjects((list) => list.filter((p) => p.id !== deleting.id));
                setDeleting(null);
                setPreview(null);
                setToast("项目已移除，正在保存");
              }}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
      <div className="toast-container" aria-live="polite" role="status">
        {storageIssue && <div className="toast" role="alert"><span>{storageIssue} 当前修改仍保留在页面，请先备份。</span><button className="button secondary" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify({ companies: companyList, projects, materials }, null, 2)], { type: 'application/json' }));
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = '知创工坊-未保存数据.json'; anchor.click(); URL.revokeObjectURL(url);
        }}>导出备份</button></div>}
        {toast && (
          <div className="toast">
            <Check size={18} />
            {toast}
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setToast("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
export default App;
