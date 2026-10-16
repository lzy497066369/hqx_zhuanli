import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AuthGate } from './features/auth/AuthGate';
import { SessionWorkspace } from './features/admin/SessionWorkspace';

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>{user => <SessionWorkspace user={user} />}</AuthGate>
  </StrictMode>,
);
