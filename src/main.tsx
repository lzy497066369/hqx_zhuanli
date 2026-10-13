import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { AuthGate } from './features/auth/AuthGate';
import { WorkspaceGate } from './features/workspaces/WorkspaceGate';

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>{user => <WorkspaceGate user={user}>{(manager, workspaceName) => <App user={user} workspaceManager={manager} workspaceName={workspaceName} />}</WorkspaceGate>}</AuthGate>
  </StrictMode>,
);
