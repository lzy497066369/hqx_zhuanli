import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Production static build: API requests are routed by Nginx at runtime.
export default defineConfig({
  define: { 'import.meta.env.STRICT_AI_E2E': 'false' },
  plugins: [react()],
});
