# Elitogram

A private, self-hosted photo and video feed for one household. One container:
Express + SQLite serving a React single-page app, with a built-in scheduler for
imports, Instagram/TikTok syncs, duplicate scans, cleanup and nightly backups.

## Run

```bash
cp .env.example .env        # then fill in every value (see below)
docker compose build
docker compose up -d
docker compose logs -f egram
```

Before the first start, the three host folders in `.env` must exist and be owned
by uid 1000. On first start, the admin account from `ADMIN_USERNAME` /
`ADMIN_PASSWORD` is created if the database has no users. You can remove both
values afterwards.

## Configuration

Every hostname, path and secret comes from the environment. `.env.example` lists
all of them.

| Variable | Purpose |
| --- | --- |
| `APP_HOST`, `APP_ORIGIN` | Public hostname (Traefik rule) and origin. All writes must send a matching `Origin` header |
| `MEDIA_HOST_DIR` | Host folder holding the library, one folder per creator handle. App-owned folders start with `_` |
| `IMPORT_HOST_DIR` | Drop folder, swept by the import job. Files younger than `IMPORT_MIN_AGE_SEC` are skipped |
| `BACKUP_HOST_DIR` | Nightly database snapshots. The newest `BACKUP_KEEP` are kept |
| `ADULT_COOKIE_SECRET` | Required in production. HMAC key for the 18+ unlock cookie |
| `VAPID_*` | Optional web push keys |

The database lives in the named volume `egram_data` (`/data` in the container).

## Jobs

Every background job is managed under Settings > Jobs. New jobs start disabled,
and each one can be turned on or off, given a new interval, or run once.

## Downloaders

yt-dlp and gallery-dl live in a virtualenv at `/opt/dl` in the image. A stale
yt-dlp is the most common reason a sync quietly finds nothing. To update them,
turn on or run the "Update downloaders" job, or rebuild the image:

```bash
docker compose build --pull && docker compose up -d
```

Instagram needs a cookies file, uploaded under Settings > Sources. TikTok works
with public profiles and needs no cookies.

## Backups and restore

Snapshots are made with SQLite's online backup API, never with a file copy,
because the database runs in WAL mode. To restore one:

```bash
docker compose stop egram
docker run --rm -v elitogram_egram_data:/data -v "$BACKUP_HOST_DIR":/backups \
  alpine cp /backups/<snapshot>.db /data/elitogram.db
docker run --rm -v elitogram_egram_data:/data alpine rm -f /data/elitogram.db-wal /data/elitogram.db-shm
docker compose start egram
```

## Development

```bash
npm ci
npm run dev:server     # API on :3000, data in ./data
npm run dev:client     # Vite on :5173
npm run typecheck && npm run lint && npm run build
```
