import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { createAiMiddleware, readAiConfig } from './server/drawingAi.ts'
import { createStorageMiddleware } from './server/storageApi.ts'
import { readStorageConfig } from './server/mysql/database.ts'
import { createAuthMiddleware } from './server/auth.ts'

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: these secrets are used only by this server-side middleware.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const config = readAiConfig(env)
  return {
    // Only a boolean reaches the client, never provider configuration or secrets.
    define: { 'import.meta.env.STRICT_AI_E2E': JSON.stringify(!!config.executionPolicy) },
    plugins: [react(), {
      name: 'utility-ai-server',
      configureServer(server) {
        const auth = createAuthMiddleware(readStorageConfig(env), env);
        server.middlewares.use(auth.middleware);
        server.httpServer?.once('close', () => { void auth.close(); });
        const storage = createStorageMiddleware(readStorageConfig(env), env.ALLOWED_ORIGINS);
        server.middlewares.use(storage.middleware);
        server.httpServer?.once('close', () => { void storage.close(); });
        const middleware = createAiMiddleware(config);
        server.middlewares.use(middleware);

        // 注册V2 API（需要express实例，但vite使用connect）
        // 暂时通过在createAiMiddleware中集成
      },
      configurePreviewServer(server) {
        const auth = createAuthMiddleware(readStorageConfig(env), env);
        server.middlewares.use(auth.middleware);
        server.httpServer.once('close', () => { void auth.close(); });
        const storage = createStorageMiddleware(readStorageConfig(env), env.ALLOWED_ORIGINS);
        server.middlewares.use(storage.middleware);
        server.httpServer.once('close', () => { void storage.close(); });
        const middleware = createAiMiddleware(config);
        server.middlewares.use(middleware);
      },
    }],
  }
})
