import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Bell,
  BookOpen,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
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
import { deleteNamingDraft, loadProjectsAsync, saveProjectsAsync } from "./storage/projectStorage";
import { Illustration } from "./components/Illustration";
import { UtilityNaming } from "./features/utility/UtilityNaming";
import { ProductWorkflowWorkspace } from './features/product/ProductWorkflowWorkspace';
import { createProductWorkflow, isProductWorkflowComplete, namingFingerprint } from './features/product/productWorkflow';
import type { ProductWorkflow } from './features/product/productWorkflow';
import { createProductWordBlob, productWordFilename } from './features/product/productWordExport';
import { createUtilityWordBlob, utilityWordFilename } from "./features/utility/wordExport";
import { createInventionWordBlob, inventionWordFilename } from './features/invention/wordExport';
import { validateInventionMaterials } from './features/invention/invention';
import type { NamingRecord } from "./features/utility/naming";
import { utilityDraftKey } from "./features/utility/naming";
import { Modal } from "./components/Modal";
import "./App.css";

type Page = "dashboard" | "projects" | "materials" | "templates" | "utility" | "invention";
type Material = { id: string; name: string; size: number };
const pages: Record<Page, string> = {
  dashboard: "工作台",
  projects: "项目管理",
  materials: "资料库",
  templates: "模板中心",
  utility: "实用新型 · 取名字",
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
  return Object.hasOwn(pages, value) ? (value as Page) : "dashboard";
}
function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [projects, setProjects] = useState<Project[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [mobileNav, setMobileNav] = useState(false);
  const [help, setHelp] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [profile, setProfile] = useState(false);
  const [toast, setToast] = useState("");
  const [utilityProject, setUtilityProject] = useState<Project | undefined>(undefined);
  const inventionProject = projects.find(p => p.category === 'invention' && p.id === location.hash.split('/')[1]);
  const [inventionStage, setInventionStage] = useState<"naming" | "workspace">("naming");
  const [utilityStage, setUtilityStage] = useState<"naming" | "workspace">("naming");
  const [editor, setEditor] = useState<Partial<Project> | null>(null);
  const [selectedCategory, setSelectedCategory] =
    useState<CategoryId>("invention");
  const [preview, setPreview] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // IndexedDB 异步加载：完成前不渲染，避免旧数据闪烁；完成前禁止写入，避免空数组覆盖数据库。
  useEffect(() => {
    let cancelled = false;
    loadProjectsAsync().then(list => {
      if (cancelled) return;
      setProjects(list);
      const hashId = location.hash.split("/")[1];
      // oxlint-disable-next-line react/set-state-in-effect -- Hydrate navigation state once storage is ready.
      setUtilityProject(list.find(p => p.category === "utility" && p.id === hashId));
      if (list.find(p => p.category === 'utility' && p.id === hashId)?.productWorkflow) setUtilityStage('workspace');
      if (list.find(p => p.category === "invention" && p.id === hashId)?.naming?.confirmed) {
        // oxlint-disable-next-line react/set-state-in-effect -- Hydrate navigation state once storage is ready.
        setInventionStage("workspace");
      }
      // oxlint-disable-next-line react/set-state-in-effect -- Hydrate navigation state once storage is ready.
      setStorageReady(true);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = getPage();
      setPage(next);
      if (next === "utility") {
        const id = location.hash.split("/")[1];
        // A bare utility route starts a new project; never reuse another project's drawing.
        // Preserve the stage chosen by an in-app action for the same project.
        if (!id || id !== utilityProject?.id) {
          const target = projects.find(project => project.category === "utility" && project.id === id);
          setUtilityProject(target);
          setUtilityStage(target?.naming?.confirmed ? "workspace" : "naming");
        }
      }
      if (next === "invention") {
        const id = location.hash.split("/")[1];
        if (!id || id !== inventionProject?.id) setInventionStage("naming");
      }
      setMobileNav(false);
      mainRef.current?.focus();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [projects, utilityProject?.id, inventionProject?.id]);
  // Storage is external; a failed write must surface a recoverable notice.
  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    saveProjectsAsync(projects).then(ok => {
      // oxlint-disable-next-line react/set-state-in-effect -- Report failed external storage writes.
      if (!cancelled && !ok) setToast("浏览器存储不可用，本次修改仅在当前页面保留。");
    });
    return () => { cancelled = true; };
  }, [projects, storageReady]);
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
  const create = (category: CategoryId = "software", name = "") => {
    if (category === "utility") {
      setUtilityProject(undefined);
      setUtilityStage("naming");
      navigate("utility");
      return;
    }
    if (category === "invention") {
      const project: Project = {
        id: crypto.randomUUID(),
        category: "invention",
        name: name.trim() || "未命名发明专利",
        owner: "",
        description: "",
        status: "draft",
        updatedAt: new Date().toISOString(),
      };
      setProjects((list) => [project, ...list]);
      setInventionStage("naming");
      location.hash = `invention/${project.id}`;
      setToast("已进入发明专利四步创作流程，请先填写企业和真实技术资料");
      return;
    }
    setError("");
    setSelectedCategory(category);
    setEditor({ category, name, description: "", owner: "" });
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
    setToast("名称已保存，进入逻辑校验、彩色预览和申请材料流程");
  };
  const saveUtilityName = (naming: NamingRecord) => {
    const id = utilityProject?.id || crypto.randomUUID();
    const project: Project = {
      id,
      category: "utility",
      name: naming.selectedName,
      owner: naming.profile.company.trim(),
      description: `产品名称：${naming.profile.business.trim()}\n保护客体：${naming.profile.product.trim() || "参见确认名称"}\n结构特征：${naming.profile.features.trim() || "参见确认名称，需在后续技术方案中展开"}`,
      status: "draft",
      updatedAt: new Date().toISOString(),
      naming,
      utilityDrawing: utilityProject?.utilityDrawing,
      utilityMaterials: utilityProject?.name === naming.selectedName &&
        JSON.stringify(utilityProject.naming?.profile) === JSON.stringify(naming.profile)
        ? utilityProject.utilityMaterials : undefined,
    };
    project.productWorkflow = utilityProject?.productWorkflow?.sourceFingerprint === namingFingerprint(project) ? utilityProject.productWorkflow : createProductWorkflow(project);
    setProjects((list) => [
      project,
      ...list.filter((p) => p.id !== project.id),
    ]);
    setUtilityProject(project);
    setUtilityStage("workspace");
    location.hash = `utility/${project.id}`;
    try { localStorage.removeItem(utilityDraftKey()); } catch { /* The form reports storage errors. */ }
    void deleteNamingDraft();
    setToast("名称已保存，开始独立检查产品逻辑，再生成详细简介和彩色预览");
  };
  const openUtilityWorkspace = () => {
    if (!utilityProject) return;
    setUtilityStage("workspace");
    // The workspace replaces the long naming page. Start the new stage at its
    // top instead of preserving the naming page's scroll position.
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  };
  const saveProductWorkflow = (projectId: string, workflow: ProductWorkflow) => {
    const apply = (item: Project): Project => {
      if (item.id !== projectId || workflow.sourceFingerprint !== namingFingerprint(item)) return item;
      return { ...item, productWorkflow: workflow, name: workflow.selection.proposedName,
        description: workflow.brief?.design.overview || item.description,
        status: isProductWorkflowComplete(workflow) ? 'ready' : 'draft', updatedAt: workflow.updatedAt };
    };
    setProjects(list => list.map(apply));
    setUtilityProject(current => current ? apply(current) : current);
  };
  const saveProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") || "").trim();
    if (!name) {
      setError("请输入项目名称，不能只包含空格。");
      (
        event.currentTarget.elements.namedItem("name") as HTMLInputElement
      ).focus();
      return;
    }
    setSaving(true);
    const project: Project = {
      id: editor?.id || crypto.randomUUID(),
      name,
      category: data.get("category") as CategoryId,
      owner: String(data.get("owner") || "").trim(),
      description: String(data.get("description") || "").trim(),
      status: "draft",
      updatedAt: new Date().toISOString(),
      ...(editor?.category === 'invention' && data.get('category') === 'invention'
        ? { inventionFacts: editor.inventionFacts, inventionMaterials: editor.inventionMaterials } : {}),
    };
    setProjects((list) => [
      project,
      ...list.filter((p) => p.id !== project.id),
    ]);
    setEditor(null);
    setSaving(false);
    if (project.category === "invention") {
      // Invention projects have a dedicated fact-confirmation workflow.
      // Open it immediately so the generic project preview is not mistaken
      // for the invention application workspace.
      location.hash = `invention/${project.id}`;
      setToast("项目已保存，请先核对技术事实并生成申请材料");
    } else {
      setToast("项目草稿已保存到此浏览器");
      setPreview(project);
    }
  };
  const download = async (project: Project) => {
    if (project.productWorkflow) {
      try {
        if (project.productWorkflow.sourceFingerprint !== namingFingerprint(project)) throw new Error('名称或特征已改变，请重新完成当前产品的预览确认。');
        const blob = await createProductWordBlob(project.productWorkflow);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = productWordFilename(project.productWorkflow); anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setToast('已导出含黑白附图和生成提示词的 Word 初稿，请专业核实后使用');
      } catch (error) { setToast(error instanceof Error ? error.message : 'Word 导出失败'); }
      return;
    }
    if (project.category === 'invention') {
      try {
        if (project.utilityDrawing && project.utilityMaterials && hasConfirmedUtilityStructure(project)) {
          const blob = await createUtilityWordBlob(project, project.utilityDrawing, project.utilityMaterials);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = utilityWordFilename(project.name, 'invention'); a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setToast('发明专利 Word 初稿已导出，请核对后进行专业审核');
          return;
        }
        if (hasConfirmedUtilityStructure(project)) throw new Error('请先生成并校验当前结构的 V2 文案，不能导出旧版材料');
        const blob = await createInventionWordBlob(project);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = inventionWordFilename(project.name); a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setToast('发明专利 Word 初稿已导出，请核对后进行专业审核');
      } catch (error) { setToast(error instanceof Error ? error.message : 'Word 导出失败'); }
      return;
    }
    if (project.category === "utility" && !hasConfirmedUtilityStructure(project)) {
      setToast("请先确定 Patent Structure Model，才能导出申请材料");
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([makeDocument(project)], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[/\\:*?"<>|]/g, '-')}-${project.category === 'utility' ? '材料初稿' : '材料模板'}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast('材料已导出，请核对后进行专业审核');
    } catch (error) { setToast(error instanceof Error ? error.message : '材料导出失败'); }
  };
  const visibleProjects =
    page === "dashboard"
      ? projects
      : projects.filter(
          (p) =>
            (filter === "all" ||
              p.status === filter ||
              p.category === filter) &&
            `${p.name}${categories.find((c) => c.id === p.category)?.name}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        );
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
            <th>类型</th>
            <th>状态</th>
            <th>最近更新</th>
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
                      onClick={() => setPreview(p)}
                    >
                      <span className={`file-icon ${c.color}`}>
                        <Icon size={19} />
                      </span>
                      <span>
                        {p.name}
                        {p.demo && <small>示例项目</small>}
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="type-label">{c.name}</span>
                  </td>
                  <td>
                    <span className={`status ${p.status}`}>
                      <span />
                      {p.status === "draft" ? "草稿" : "已整理"}
                    </span>
                  </td>
                  <td className="date">
                    {new Date(p.updatedAt)
                      .toLocaleDateString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                      })
                      .replaceAll("/", "-")}
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`查看${p.name}`}
                      onClick={() => setPreview(p)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {visibleProjects.length === 0 && (
        <div className="empty-state">
          <Search size={30} />
          <h3>
            {query || filter !== "all"
              ? "没有找到相关项目"
              : "从第一份创意开始"}
          </h3>
          <p>
            {query || filter !== "all"
              ? "试试其他关键词，或切换项目筛选条件。"
              : "选择一种知识产权类型，创建你的第一个项目。"}
          </p>
          <button
            className="button secondary"
            onClick={() => {
              if (query || filter !== "all") {
                setQuery("");
                setFilter("all");
              } else create();
            }}
          >
            {query || filter !== "all" ? "清除筛选" : "新建项目"}
          </button>
        </div>
      )}
    </div>
  );
  if (!storageReady) {
    return (
      <div className="app-shell">
        <div className="empty-state">
          <h2>正在加载本地项目…</h2>
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
        <div className="workspace-label">
          <span className="workspace-avatar">知</span>
          <span>
            我的创作空间<small>个人工作空间</small>
          </span>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav aria-label="主要导航">
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
                <span className="nav-count">{projects.length}</span>
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
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={19} />
            <span>使用指南</span>
            <span className="external-arrow">↗</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-icon">
              <ShieldCheck size={20} />
            </span>
            <strong>创意，由你掌握</strong>
            <p>
              当前为前端体验版
              <br />
              项目草稿保存在此浏览器
            </p>
            <button onClick={() => setHelp(true)}>
              了解工作流程 <ArrowUpRight />
            </button>
          </div>
          <button className="sidebar-help" onClick={() => setHelp(true)}>
            <CircleHelp size={17} /> 帮助与反馈 <ChevronRight size={15} />
          </button>
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
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{page === "utility" && utilityStage === "workspace" ? "实用新型 · 产品预览与成品" : pages[page]}</strong>
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
                  setFilter("all");
                  if (page !== "projects") navigate("projects");
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
                知
              </button>
              {profile && (
                <div className="popover">
                  <strong>个人工作空间</strong>
                  <p>
                    当前使用访客模式，未连接账户服务。项目仅保存在当前浏览器，请及时导出重要材料。
                  </p>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1}>
          {page === 'invention' && inventionProject ? (
            inventionStage === "workspace" && inventionProject.naming ? (
              <ProductWorkflowWorkspace key={inventionProject.id} project={inventionProject}
                onSave={saveProductWorkflow} onBack={() => setInventionStage("naming")} />
            ) : (
              <UtilityNaming key={inventionProject.id} project={inventionProject} patentType="invention"
                onSave={saveInventionName} onOpenWorkspace={() => setInventionStage("workspace")} onBack={() => navigate("dashboard")} />
            )
          ) : page === "utility" ? (
            utilityStage === "workspace" && utilityProject ? (
              <ProductWorkflowWorkspace
                key={utilityProject.id}
                project={utilityProject}
                onSave={saveProductWorkflow}
                onBack={() => setUtilityStage("naming")}
              />
            ) : (
              <UtilityNaming
                key={utilityProject?.id || "new-utility"}
                project={utilityProject}
                onSave={saveUtilityName}
                onOpenWorkspace={openUtilityWorkspace}
                onBack={() => navigate("dashboard")}
              />
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
                          navigate("projects");
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
                  <button className="text-button" onClick={() => setHelp(true)}>
                    <CircleHelp size={15} />
                    如何选择？
                  </button>
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
                        navigate("projects");
                      }}
                    >
                      查看全部
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  {projectTable}
                </section>
                <section className="guide-card">
                  <div className="guide-heading">
                    <span>
                      <Sparkles size={17} />
                      创作小指南
                    </span>
                    <span className="guide-mini" aria-hidden="true">
                      QUICK START
                    </span>
                  </div>
                  <h3>从想法到材料，只需三步</h3>
                  <ol>
                    <li>
                      <span>1</span>
                      <div>
                        <strong>选择创作类型</strong>
                        <p>找到适合你的知识产权方向</p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>描述你的创意</strong>
                        <p>填写项目信息，梳理创新要点</p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>完善并导出材料</strong>
                        <p>按模板补充内容，交由专业人员审核</p>
                      </div>
                    </li>
                  </ol>
                  <button onClick={() => setHelp(true)}>
                    查看完整使用指南
                    <ArrowRight size={15} />
                  </button>
                </section>
              </div>
              <div className="bottom-note">
                <ShieldCheck size={15} />
                <span>专注创作，安心记录</span>
                <i />
                当前为前端预览，示例数据仅用于展示
              </div>
            </>
          ) : (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">YOUR CREATIVE WORKSPACE</div>
                  <h1>{pages[page]}</h1>
                  <p>
                    {page === "projects"
                      ? "管理每一份创意，让创新成果井然有序。"
                      : page === "materials"
                        ? "整理你的参考文件，为下一次创作做好准备。"
                        : "从结构化模板开始，告别面对空白页的犹豫。"}
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() =>
                    page === "materials" ? upload.current?.click() : create()
                  }
                >
                  {page === "materials" ? (
                    <Upload size={18} />
                  ) : (
                    <Plus size={18} />
                  )}{" "}
                  {page === "materials" ? "选择本地文件" : "新建项目"}
                </button>
              </section>
              {page === "projects" && (
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
                        value={
                          categories.some((c) => c.id === filter)
                            ? filter
                            : "all"
                        }
                        onChange={(e) => setFilter(e.target.value)}
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
                  {projectTable}
                </section>
              )}
              {page === "templates" && (
                <>
                  <div className="info-banner">
                    <CircleHelp size={18} />
                    模板用于信息整理，不包含真实 AI 生成内容，也不替代专业审核。
                  </div>
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
                          id: crypto.randomUUID(),
                          name: file.name,
                          size: file.size,
                        })),
                      ]);
                      if (files.length)
                        setToast(
                          `已添加 ${files.length} 个文件的本地信息，未上传文件内容`,
                        );
                      e.target.value = "";
                    }}
                  />
                  <div className="info-banner">
                    <ShieldCheck size={18} />
                    本页面仅展示所选文件的名称和大小，不上传内容；刷新页面后将清空。
                  </div>
                  {materials.length ? (
                    <div className="materials-list">
                      {materials.map((m) => (
                        <div className="material-row" key={m.id}>
                          <FileText size={24} />
                          <div>
                            <strong>{m.name}</strong>
                            <p>{(m.size / 1024).toFixed(1)} KB · 仅本次会话</p>
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
            <button onClick={() => setHelp(true)}>
              关于工作空间
              <ArrowUpRight />
            </button>
          </footer>
        </main>
      </div>
      {editor && (
        <Modal
          title={editor.id ? "编辑项目" : "开始一份新的创作"}
          onClose={() => {
            const form = document.getElementById(
              "project-form",
            ) as HTMLFormElement;
            const data = form ? new FormData(form) : null;
            const dirty =
              data &&
              ["name", "owner", "description", "category"].some(
                (key) =>
                  String(data.get(key) || "") !==
                  String(editor[key as keyof Project] || ""),
              );
            if (!dirty || window.confirm("有尚未保存的修改，确定放弃吗？"))
              setEditor(null);
          }}
        >
          <form id="project-form" onSubmit={saveProject}>
            <p className="form-intro">
              记录创意的起点。保存后，你可以预览并导出材料整理模板。
            </p>
            <label htmlFor="category">知识产权类型</label>
            <select
              id="category"
              name="category"
              value={editor.category || selectedCategory}
              onChange={(e) => {
                if (e.target.value === "utility") {
                  setEditor(null);
                  setUtilityProject(
                    editor.id
                      ? ({ ...editor, category: "utility" } as Project)
                      : undefined,
                  );
                  navigate("utility");
                } else {
                  const category = e.target.value as CategoryId;
                  setSelectedCategory(category);
                  setEditor(previous => previous ? { ...previous, category } : previous);
                }
              }}
            >
              {categories.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label htmlFor="project-name">
              项目名称 <span className="required">*</span>
            </label>
            <input
              data-autofocus
              id="project-name"
              name="name"
              required
              maxLength={100}
              defaultValue={editor.name}
              placeholder="为你的创意起一个清晰的名字"
              aria-describedby={error ? "name-error" : undefined}
            />
            {error && (
              <p id="name-error" className="form-error" role="alert">
                {error}
              </p>
            )}
            <label htmlFor="owner">
              申请人 / 著作权人 <span className="optional">选填</span>
            </label>
            <input
              id="owner"
              name="owner"
              defaultValue={editor.owner}
              maxLength={100}
              placeholder="个人或企业名称"
            />
            <label htmlFor="description">
              创意描述 <span className="optional">选填</span>
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              defaultValue={editor.description}
              maxLength={5000}
              placeholder={
                categories.find((c) => c.id === selectedCategory)?.hint
              }
            />
            <p className="field-help">
              <ShieldCheck size={14} />
              草稿仅保存在当前浏览器，不会上传至服务器。
            </p>
            <div className="form-footer">
              <span>先记录，再慢慢完善</span>
              <button
                className="button primary"
                type="submit"
                disabled={saving}
              >
                <Check size={17} />
                {saving ? "保存中…" : "保存并预览"}
              </button>
            </div>
          </form>
        </Modal>
      )}
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
          <div className="info-banner">
            <CircleHelp size={17} />
            {preview.productWorkflow ? 'AI 生成的材料初稿需专业核实，不代表专利授权或工程认证。' : '以下为待完善的材料模板，不是正式申请文件。'}
          </div>
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
                if (preview.category === "utility") {
                  setUtilityProject(preview);
                  setUtilityStage("naming");
                  location.hash = `utility/${preview.id}`;
                } else if (preview.category === 'invention' && preview.naming) {
                  setInventionStage('naming');
                  location.hash = `invention/${preview.id}`;
                } else {
                  setEditor(preview);
                  setSelectedCategory(preview.category);
                }
                setPreview(null);
                setError("");
              }}
            >
              编辑项目
            </button>
            {preview.category === "utility" && (
              <button
                className="button secondary"
                onClick={() => {
                  setUtilityProject(preview);
                  setUtilityStage("workspace");
                  location.hash = `utility/${preview.id}`;
                  setPreview(null);
                }}
              >
                <PenLine size={16} />
                产品预览与成品
              </button>
            )}
            {preview.category === 'invention' && <button className="button secondary" onClick={() => {
              location.hash = `invention/${preview.id}`; setPreview(null);
            }}><PenLine size={16} /> 发明申请材料</button>}
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
              disabled={preview.productWorkflow ? !isProductWorkflowComplete(preview.productWorkflow) || preview.productWorkflow.sourceFingerprint !== namingFingerprint(preview) : (preview.category === "utility" && !hasConfirmedUtilityStructure(preview)) ||
                (preview.category === 'invention' && (() => { try { validateInventionMaterials(preview.name, preview.inventionFacts, preview.inventionMaterials); return false; } catch { return true; } })())}
            >
              <ArrowDownToLine size={16} />
              {preview.productWorkflow || preview.category === 'invention' ? '下载 Word' : '导出模板'}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="删除这个项目？" onClose={() => setDeleting(null)}>
          <p className="delete-message">
            “{deleting.name}”将从当前浏览器移除，此操作无法撤销。
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
                setToast("项目已删除");
              }}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal title="让好想法，从这里开始" onClose={() => setHelp(false)} wide>
          <p className="form-intro">知创工坊 · 前端体验指南</p>
          <div className="help-grid">
            {categories.map((c) => {
              const Icon = categoryIcons[c.id];
              return (
                <div key={c.id}>
                  <span className={`file-icon ${c.color}`}>
                    <Icon size={21} />
                  </span>
                  <h3>{c.name}</h3>
                  <p>{c.hint}。</p>
                </div>
              );
            })}
          </div>
          <div className="help-steps">
            <h3>你的创作路径</h3>
            <p>
              ① 选择类型 → ② 填写项目信息 → ③ 保存草稿 → ④ 导出模板并补充材料
            </p>
          </div>
          <div className="info-banner">
            <ShieldCheck size={19} />
            <span>
              这是纯前端原型，尚未接入
              AI、账号或申报服务。示例项目不是实际业务记录；草稿仅存于此浏览器，清理网站数据会使其丢失。正式材料请交由专业人员审核。
            </span>
          </div>
          <button
            className="button primary"
            onClick={() => {
              setHelp(false);
              create();
            }}
          >
            创建我的第一个项目
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      <div className="toast-container" aria-live="polite" role="status">
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
function ArrowUpRight() {
  return <ArrowRight size={14} className="arrow-up" />;
}
export default App;
