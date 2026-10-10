# 知创工坊：前端 + 本机 AI 服务 + FreeCAD（headless）
# 构建：docker build -t zhichuang-workshop .
# 运行：见 docker-compose.yml 或 docs/deploy-docker.md

# ---- 阶段 1：构建前端 ----
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 阶段 2：运行镜像 ----
FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    FREECAD_CMD=/usr/bin/freecadcmd \
    QT_QPA_PLATFORM=offscreen \
    FREECAD_USER_HOME=/tmp/freecad-home
# Debian bookworm 自带 FreeCAD 0.20（含 freecadcmd 无界面命令行），满足 Part 建模与网格导出。
RUN apt-get update && apt-get install -y --no-install-recommends freecad fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /tmp/freecad-home
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
# 以非 root 运行；FreeCAD 临时目录位于 /tmp，由应用用后即删。
RUN useradd --system --create-home --shell /usr/sbin/nologin zhichuang && chown -R zhichuang:zhichuang /app /tmp/freecad-home
USER zhichuang
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/index.ts"]
