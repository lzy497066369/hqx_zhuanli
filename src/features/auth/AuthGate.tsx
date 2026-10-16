import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, Check, Eye, EyeOff, LoaderCircle, LockKeyhole, Sparkles, UserRound } from 'lucide-react';
import './auth.css';
import { authRequest } from './authApi';
import type { AuthUser } from './authApi';


export function AuthGate({ children }: { children: (user: AuthUser | null) => ReactNode }) {
  const [session, setSession] = useState<{ enabled: boolean; user: AuthUser | null } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    authRequest<{ enabled: boolean; user: AuthUser | null }>('me').then(result => {
      if (!cancelled) {
        if (result.user && result.user.role !== 'admin' && !location.hash) history.replaceState(null, '', '#projects');
        setLoadError(''); setSession(result);
      }
    }).catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : '登录状态加载失败。'); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (!session) return <main className="auth-loading"><div className="auth-brand-icon"><Sparkles size={28} /></div><h1>知创工坊</h1>{loadError
    ? <><p role="alert">{loadError}</p><button className="auth-submit" onClick={() => { setLoadError(''); setAttempt(value => value + 1); }}>重新连接 <ArrowRight size={18} /></button></>
    : <p role="status"><LoaderCircle className="auth-spinner" size={18} /> 正在确认登录状态…</p>}</main>;
  if (!session.enabled || session.user) return children(session.user);
  return <AuthPage onAuthenticated={user => {
    if (user.role !== 'admin') history.replaceState(null, '', '#projects');
    setSession({ enabled: true, user });
  }} />;
}

function AuthPage({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (register && password !== confirmation) { setError('两次输入的密码不一致。'); return; }
    setBusy(true);
    try {
      const result = await authRequest<{ user: AuthUser }>(register ? 'register' : 'login', {
        username, password, ...(register ? { displayName: displayName.trim() || username.trim() } : {}),
      });
      setPassword(''); setConfirmation(''); onAuthenticated(result.user);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '提交失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  function switchMode(next: boolean) { setRegister(next); setError(''); setPassword(''); setConfirmation(''); setShowPassword(false); }
  return <main className="auth-page">
    <section className="auth-story" aria-label="知创工坊">
      <div className="auth-brand"><span className="auth-brand-icon"><Sparkles size={24} /></span><span>知创工坊<small>IDEAS INTO ASSETS</small></span></div>
      <div className="auth-story-content">
        <span className="auth-eyebrow">给每一个好想法，一个开始</span>
        <h1>从灵感，<br />到属于你的<span>创新成果。</span></h1>
        <p>在一个工作台里，完成知识产权材料的创作、整理与保存。</p>
        <div className="auth-category-list"><span>发明专利</span><span>实用新型</span><span>外观设计</span><span>软件著作权</span></div>
        <div className="auth-illustration" aria-hidden="true">
          <div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" />
          <div className="auth-paper"><div className="auth-paper-head"><Sparkles size={20} /><span>让创意成为成果</span></div><div className="auth-paper-line" /><div className="auth-paper-line short" /><div className="auth-paper-grid"><span /><span /><span /></div><div className="auth-paper-foot"><Check size={14} /> 每一步，都有迹可循</div></div>
          <div className="auth-seal"><Check size={25} /></div>
        </div>
      </div>
      <p className="auth-story-footer">让创新更简单，让价值被看见。</p>
    </section>
    <section className="auth-form-section" aria-label={register ? '注册账号' : '账号登录'}>
      <div className="auth-form-wrap">
        <div className="auth-tabs" aria-label="账号操作"><button type="button" className={!register ? 'active' : ''} aria-pressed={!register} disabled={busy} onClick={() => switchMode(false)}>登录</button><button type="button" className={register ? 'active' : ''} aria-pressed={register} disabled={busy} onClick={() => switchMode(true)}>注册</button></div>
        <div className="auth-form-heading"><span className="auth-eyebrow">YOUR CREATIVE WORKSPACE</span><h2>{register ? '开启你的创作之旅' : '欢迎回到知创工坊'}</h2><p>{register ? '创建一个账号，让好想法在这里落地。' : '登录账号，继续你的下一份创作。'}</p></div>
        <form onSubmit={submit} className="auth-form">
          {register && <label htmlFor="auth-display-name">昵称 <span className="auth-optional">选填</span><div className="auth-field"><UserRound size={18} /><input id="auth-display-name" autoComplete="nickname" placeholder="希望我们如何称呼你" maxLength={80} value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={busy} /></div></label>}
          <label htmlFor="auth-username">账号<div className="auth-field"><UserRound size={18} /><input id="auth-username" autoComplete="username" placeholder="输入账号" minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" title="3–32 位字母、数字或下划线" required value={username} onChange={event => setUsername(event.target.value)} disabled={busy} aria-describedby={register ? 'auth-username-hint' : undefined} /></div></label>
          {register && <p id="auth-username-hint" className="auth-hint">3–32 位字母、数字或下划线，不区分大小写。</p>}
          <label htmlFor="auth-password">密码<div className="auth-field"><LockKeyhole size={18} /><input id="auth-password" type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? '设置至少 8 位密码' : '输入密码'} minLength={8} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><button className="auth-eye" type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(value => !value)} disabled={busy}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          {register && <label htmlFor="auth-confirmation">确认密码<div className="auth-field"><LockKeyhole size={18} /><input id="auth-confirmation" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="再输入一次密码" minLength={8} maxLength={128} required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></div></label>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>{busy ? <><LoaderCircle size={19} className="auth-spinner" />{register ? '正在创建账号…' : '正在登录…'}</> : <>{register ? '创建账号并进入' : '登录工作台'}<ArrowRight size={19} /></>}</button>
        </form>
        <p className="auth-switch">{register ? '已经有账号？' : '还没有账号？'}<button type="button" onClick={() => switchMode(!register)} disabled={busy}>{register ? '立即登录' : '创建账号'}</button></p>
        <div className="auth-note"><LockKeyhole size={16} /><span>账号登录后即可使用工作空间</span></div>
      </div>
      <p className="auth-copyright">© {new Date().getFullYear()} 知创工坊</p>
    </section>
  </main>;
}
