# Multi-stage build. better-sqlite3 and sharp are native modules, so they are
# compiled inside the image against its own glibc — never copied in from the
# host. The production stage ships the full prod node_modules (not Next's
# standalone trace) for two reasons: a custom server (server.mjs) hosts the
# WebSocket endpoint and the job scheduler alongside Next, and scripts/*.mjs run
# in this container and need better-sqlite3, sharp and ffmpeg at runtime.

FROM node:20-slim AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-slim AS prod-deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATA_DIR=/app/data

# libheif (heif-convert) decodes iPhone HEIC/HEIF, which sharp's bundled libvips
# cannot — those are converted to JPEG before any sharp processing. ffmpeg and
# ffprobe remux video posts, extract poster frames and read media metadata.
# curl drives the Instagram web_profile_info API (its TLS fingerprint dodges the
# rate limits Node's fetch hits) and gallery-dl downloads photos and carousels;
# Instaloader answers the profile-info and account-existence questions. yt-dlp
# itself is bind-mounted (YT_DLP_BIN) so it can be updated on the host without
# rebuilding the image — the single most common cause of a sync that stops
# working is a stale copy of it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libheif-examples ffmpeg curl ca-certificates python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages gallery-dl instaloader \
  && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data && chown -R nextjs:nodejs /app

COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --chown=nextjs:nodejs package.json next.config.mjs server.mjs ./
# Maintenance scripts, run in this container by the in-app job scheduler.
COPY --chown=nextjs:nodejs scripts ./scripts
# The custom server imports the job runtime at startup. It lives in lib/ but is
# NOT part of Next's traced output (Next traces its own server, not ours), so
# ship this one file explicitly. The route handlers import the same module via
# a bundled copy inside .next.
COPY --chown=nextjs:nodejs lib/jobs-runtime.mjs ./lib/jobs-runtime.mjs

USER nextjs
EXPOSE 3000
CMD ["node", "server.mjs"]
