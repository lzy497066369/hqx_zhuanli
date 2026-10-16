# 知创工坊后端：Node API + FreeCAD（headless），不包含前端 dist。
# 构建：docker build -t zhichuang-backend:latest .
# 运行：见 docker-compose.yml 或 docs/deploy-docker.md

FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    SERVE_FRONTEND=false \
    FREECAD_CMD=/usr/bin/freecadcmd \
    QT_QPA_PLATFORM=offscreen \
    FREECAD_USER_HOME=/tmp/freecad-home
# Debian bookworm 自带 FreeCAD 0.20（含 freecadcmd 无界面命令行），满足 Part 建模与网格导出。
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends freecad fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /tmp/freecad-home
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --omit=dev --registry=$NPM_REGISTRY
COPY server ./server
# API 使用 src 内的共享业务模型；这些源码不会作为静态文件暴露。
COPY src ./src
# 以非 root 运行；FreeCAD 临时目录位于 /tmp，由应用用后即删。
RUN useradd --system --create-home --shell /usr/sbin/nologin zhichuang && mkdir -p /home/zhichuang/.local/state/zhichuang-workshop/cad-checkpoints \
    && chown -R zhichuang:zhichuang /app /tmp/freecad-home /home/zhichuang
USER zhichuang
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4173/api/storage/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/index.ts"]
