import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { createAiMiddleware, readAiConfig } from './server/drawingAi.ts'

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: these secrets are used only by this server-side middleware.
  const config = readAiConfig({ ...loadEnv(mode, process.cwd(), 'AI_'), ...process.env })
  return {
    // Only a boolean reaches the client, never provider configuration or secrets.
    define: { 'import.meta.env.STRICT_AI_E2E': JSON.stringify(!!config.executionPolicy) },
    plugins: [react(), {
      name: 'utility-ai-server',
      configureServer(server) {
        const middleware = createAiMiddleware(config);
        server.middlewares.use(middleware);

        // 注册V2 API（需要express实例，但vite使用connect）
        // 暂时通过在createAiMiddleware中集成
      },
      configurePreviewServer(server) {
        const middleware = createAiMiddleware(config);
        server.middlewares.use(middleware);
      },
    }],
  }
})
