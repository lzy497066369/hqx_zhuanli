import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Check, ChevronDown, FolderClosed, Plus, Settings2, Trash2 } from 'lucide-react';
import type { AuthUser } from '../auth/authApi';
import { Modal } from '../../components/Modal';
import { selectStorageWorkspace } from '../../storage/workspaceContext';
import { flushStorage } from '../../storage/storageApi';
import './workspaces.css';

type Workspace = { id: string; name: string; description: string };
async function request<T>(path = '', method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/workspaces${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) throw new Error(value?.error?.message || '工作空间服务暂时不可用。');
  return value as T;
}
function remembered(userId: string): string | null {
  try { return sessionStorage.getItem(`zhichuang:workspace:${userId}`); } catch { return null; }
}
function remember(userId: string, workspaceId: string) {
  try { sessionStorage.setItem(`zhichuang:workspace:${userId}`, workspaceId); }
  catch { throw new Error('浏览器无法记住所选工作空间，请检查存储设置。'); }
}

export function WorkspaceGate({ user, children }: { user: AuthUser | null; children: (manager: ReactNode, workspaceName?: string) => ReactNode }) {
  const userId = user?.id;
  const [spaces, setSpaces] = useState<Workspace[] | null>(null);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    request<{ workspaces: Workspace[] }>().then(({ workspaces }) => {
      if (cancelled) return;
      const workspace = workspaces.find(space => space.id === remembered(userId)) || workspaces[0];
      if (!workspace) throw new Error('尚无可用工作空间。');
      remember(userId, workspace.id);
      selectStorageWorkspace(workspace.id);
      setSpaces(workspaces); setSelected(workspace); setError('');
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '工作空间加载失败。'); });
    return () => { cancelled = true; };
  }, [userId, retry]);
  if (!user) return children(null);
  if (!spaces || !selected) return <div className="auth-loading"><h1>你的工作空间</h1>{error ? <><p role="alert">{error}</p><button className="auth-submit" onClick={() => setRetry(value => value + 1)}>重新加载</button></> : <p>正在加载…</p>}</div>;
  return children(<WorkspaceManager user={user} spaces={spaces} selected={selected} onUpdate={(next, active) => { setSpaces(next); setSelected(active); }} />, selected.name);
}

function WorkspaceManager({ user, spaces, selected, onUpdate }: {
  user: AuthUser; spaces: Workspace[]; selected: Workspace; onUpdate: (spaces: Workspace[], active: Workspace) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<Workspace | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function switchSpace(workspaceId: string) {
    if (busy || workspaceId === selected.id) { setMenu(false); return; }
    setBusy(true); setError('');
    try {
      await flushStorage();
      if (!window.confirm('切换工作空间会关闭当前编辑页面，并停止页面中正在生成的任务。确认切换？')) return;
      remember(user.id, workspaceId);
      location.assign(`${location.pathname}${location.search}#dashboard`);
      location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '切换失败。'); }
    finally { setBusy(false); }
  }
  function edit(workspace: Workspace | 'new') { setEditing(workspace); setName(workspace === 'new' ? '' : workspace.name); setDescription(workspace === 'new' ? '' : workspace.description); setError(''); setMenu(false); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ workspace: Workspace }>(editing === 'new' ? '' : `/${editing.id}`, editing === 'new' ? 'POST' : 'PATCH', { name, description });
      const next = editing === 'new' ? [...spaces, result.workspace] : spaces.map(space => space.id === result.workspace.id ? result.workspace : space);
      onUpdate(next, selected.id === result.workspace.id ? result.workspace : selected);
      setEditing(null); setManage(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!deleting || busy) return;
    setBusy(true); setError('');
    try {
      await flushStorage();
      await request(`/${deleting.id}`, 'DELETE', { confirmName });
      if (deleting.id === selected.id) { location.assign(`${location.pathname}${location.search}#dashboard`); location.reload(); return; }
      onUpdate(spaces.filter(space => space.id !== deleting.id), selected);
      setDeleting(null); setManage(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败。'); }
    finally { setBusy(false); }
  }
  const close = () => { if (!busy) { setEditing(null); setDeleting(null); setManage(false); setError(''); } };
  return <div className="workspace-picker">
    <button className="workspace-current" aria-label="切换工作空间" aria-expanded={menu} onClick={() => { setMenu(value => !value); setError(''); }}><FolderClosed size={18} /><span><strong>{selected.name}</strong><small>个人工作空间 · {spaces.length} 个空间</small></span><ChevronDown size={15} /></button>
    {menu && <div className="workspace-menu"><div className="workspace-menu-heading">我的工作空间</div>{spaces.map(space => <button key={space.id} disabled={busy} onClick={() => { void switchSpace(space.id); }} className={space.id === selected.id ? 'selected' : ''}><span>{space.name}</span>{space.id === selected.id && <Check size={15} />}</button>)}<button onClick={() => edit('new')}><Plus size={15} />新建工作空间</button><button onClick={() => { setManage(true); setMenu(false); }}><Settings2 size={15} />管理工作空间</button>{error && <p role="alert">{error}</p>}</div>}
    {manage && !editing && !deleting && <Modal title="管理工作空间" onClose={close}><p className="form-intro">你的空间仅对当前账号可见，项目和资料彼此独立。</p><div className="workspace-list">{spaces.map(space => <div className="workspace-row" key={space.id}><div><strong>{space.name}</strong><p>{space.description || '暂无简介'}{space.id === selected.id ? ' · 当前空间' : ''}</p></div><div className="workspace-row-actions"><button className="button secondary" disabled={busy} onClick={() => edit(space)}>编辑</button>{space.id !== selected.id && <button className="button secondary" disabled={busy} onClick={() => { void switchSpace(space.id); }}>进入</button>}<button className="icon-button" aria-label={`删除工作空间${space.name}`} onClick={() => { setDeleting(space); setConfirmName(''); setError(''); }}><Trash2 size={17} /></button></div></div>)}</div>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary" onClick={() => edit('new')}><Plus size={17} />新建工作空间</button></Modal>}
    {editing && <Modal title={editing === 'new' ? '新建工作空间' : '编辑工作空间'} onClose={close}><form onSubmit={save} className="workspace-form"><label htmlFor="workspace-name">空间名称<input id="workspace-name" data-autofocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="例如：研发项目、软件材料" /></label><label htmlFor="workspace-description">空间简介<textarea id="workspace-description" maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={busy} placeholder="选填，记录这个空间的用途" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="confirm-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : editing === 'new' ? '创建空间' : '保存空间'}</button></div></form></Modal>}
    {deleting && <Modal title="删除工作空间" onClose={close}><form onSubmit={remove} className="workspace-form"><p>删除“{deleting.name}”会一并删除该空间内的所有项目、草稿和资料信息，此操作无法撤销。</p><label htmlFor="workspace-confirm">输入空间名称确认<input id="workspace-confirm" data-autofocus required value={confirmName} onChange={event => setConfirmName(event.target.value)} disabled={busy} /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="confirm-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>保留空间</button><button className="button danger-button" disabled={busy || confirmName !== deleting.name}>{busy ? '正在删除…' : '确认删除空间'}</button></div></form></Modal>}
  </div>;
}
