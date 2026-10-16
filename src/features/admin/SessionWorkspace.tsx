import { useEffect, useState } from 'react';
import App from '../../App';
import { WorkspaceGate } from '../workspaces/WorkspaceGate';
import type { AuthUser } from '../auth/authApi';
import { AdminConsole } from './AdminConsole';

export function SessionWorkspace({ user }: { user: AuthUser | null }) {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const update = () => setHash(location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  if (user?.role === 'admin' && (!hash || hash === '#admin')) return <AdminConsole user={user} />;
  return <WorkspaceGate user={user}>{(manager, workspaceName) => <App user={user} workspaceManager={manager} workspaceName={workspaceName} />}</WorkspaceGate>;
}
