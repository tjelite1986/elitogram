# --- Build: compile native modules for this platform and build client + server ---
FROM node:20-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# --- Runtime ---
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp and gallery-dl live in their own virtualenv, owned by the app user so the
# in-app "update downloaders" job can upgrade them without a rebuild.
RUN python3 -m venv /opt/dl \
 && /opt/dl/bin/pip install --no-cache-dir --upgrade pip 'yt-dlp[default,curl-cffi]' gallery-dl \
 && chown -R 1000:1000 /opt/dl

ENV NODE_ENV=production \
    TZ=Europe/Stockholm \
    PORT=3000 \
    DATA_DIR=/data \
    MEDIA_ROOT=/media \
    IMPORT_DIR=/import \
    BACKUP_DIR=/backups \
    STATIC_DIR=/app/dist/client \
    YTDLP_BIN=/opt/dl/bin/yt-dlp \
    GALLERYDL_BIN=/opt/dl/bin/gallery-dl \
    DOWNLOADER_PIP=/opt/dl/bin/pip

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data /media /import /backups && chown 1000:1000 /data /media /import /backups
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server/index.js"]
