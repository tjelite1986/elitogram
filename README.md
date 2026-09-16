# Elitogram

A photo-and-video feed: posts with carousels, creators and the people behind
them, 24-hour stories, hashtags, a drop folder, Instagram and TikTok pollers and
a duplicate scanner.

It was the `/posts` section of
[elite-v2](https://github.com/tjelite1986/elite-v2) until 2026-09-16, when the
library — the feed, the people directory, both syncs and the profile layer that
describes them — was extracted into this app. elite-v2 keeps the accounts and
redirects every old link here.

Nothing here names the machine it runs on: the hostnames, the media root and the
address of the app it borrows its login from all come from the environment.

---

## What it is

| | |
|---|---|
| Stack | Next 15 (App Router), React 19, Tailwind, better-sqlite3 + Kysely |
| Database | one SQLite file, `DATA_DIR/elitogram.db` |
| Media | on disk, under `POSTS_ROOT` — never in the database |
| Accounts | none of its own; sign-in is elite-v2's (see [Sign-in](#sign-in)) |
| Dev | `npm run dev` → :3021 |

### Pages

| Path | |
|---|---|
| `/` | the feed |
| `/explore` | the whole library as a grid |
| `/videos` | the library's clips, as an immersive feed or a grid |
| `/p/<id>` | one post |
| `/people`, `/people/<handle>` | the directory, and one person's profile |
| `/people/<handle>/edit` | that person's display name, bio, links and sources |
| `/u/<username>` | one account's own posts (`/me` redirects here) |
| `/tag/<tag>` | a hashtag as a grid |
| `/create`, `/edit` | post, and edit what you posted |
| `/settings` | Import, Duplicates, Cleaning, Profiles, Sources, 18+ access, Background jobs |

---

## Sign-in

There are no accounts here. elite-v2 scopes its session cookie to the parent
domain, so a browser signed in there arrives here already signed in; the token
behind that cookie is posted to elite-v2's `POST /api/auth/verify`
(`ELITE_VERIFY_URL`, over the internal network) and comes back as the account's
id, email, role, username, display name and avatar URL.

Verifying the signature locally would need elite-v2's `JWT_SECRET` and would
still accept a session that had been revoked — that row is in elite-v2's
database. So the token goes back to be resolved, and the secret never leaves the
app that owns it (`lib/sso.ts`).

Accounts that have signed in are mirrored into a local `users` table, keyed by
**elite-v2's own id** — the same integer the migrated rows already carry, so a
like or a comment written before the split still points at the right person.

`GATE_SECRET` is this app's only key of its own. It signs the 18+ unlock cookie
and nothing else; it is deliberately not elite-v2's `JWT_SECRET`.

---

## The library on disk

One tree, one owner, under `POSTS_ROOT`:

```
<POSTS_ROOT>/
  <creator>/            one folder per creator the library is filed under
  _import/              the shared drop folder (the posts-import job sweeps it)
  u_<user>/posts/       an account's own uploads
  avatars/  banners/    profile pictures and covers
```

The database stores a `storage_key` relative to that root, never a blob and
never an absolute path, so the tree can move as long as the relative shape is
kept.

---

## Sources

A profile may name an Instagram or a TikTok handle to pull from, and the sync
jobs poll every profile that has auto-poll on. The IG handle can differ from the
local one; synced media is filed under the **local** handle so it attaches to
that profile.

Instagram needs a session cookie (`IG_COOKIES_PATH`, Netscape format). More than
one can be configured: the root `cookies.txt` is the "default" identity and one
`cookies.txt` per subfolder of `IG_COOKIES_ROOT` adds another, rotated
sticky-per-profile so a given creator is always fetched as the same identity.
Request spacing (`IG_SLEEP_REQUEST`, `IG_PROFILE_SLEEP_SECONDS`,
`IG_COOLDOWN_MINUTES`) is deliberately conservative — Instagram answers a burst
with a soft block that outlives it by hours.

TikTok syncs public profiles without a cookie; `TIKTOK_COOKIES_PATH` is only
needed for private ones.

Both syncs shell out to `yt-dlp` (`YT_DLP_BIN`). A stale copy is the single most
common cause of a sync that quietly stops finding anything, so it is worth
pointing that variable at a binary you keep current rather than one baked into
an image.

---

## Background jobs

An in-app scheduler owns them (no cron, no timers), configurable under
**Settings → Background jobs**, where each can be enabled, re-intervalled or run
once by hand.

| Job | |
|---|---|
| `db-maintenance` | WAL checkpoint + planner statistics |
| `db-backup` | `VACUUM INTO` a timestamped copy in `BACKUP_DIR`, keep the newest `BACKUP_KEEP` |
| `posts-import` | sort what was dropped in `_import/` onto profiles |
| `posts-dupescan` | scan for duplicate images — reports only, deletes nothing |
| `posts-cleanup` | drop media rows whose file is gone, prune emptied posts |
| `stories-cleanup` | delete expired stories, rows and files |
| `instagram-sync` | poll every profile with IG auto-poll on |
| `instagram-avatar-backfill` | fetch a profile picture for creators that have none |
| `tiktok-sync` | poll every profile with TikTok auto-poll on |

---

## Environment

| | |
|---|---|
| `DATA_DIR` | where `elitogram.db` lives |
| `POSTS_ROOT` | the media tree |
| `ELITE_VERIFY_URL` | elite-v2's verify endpoint — unset means nobody can sign in |
| `ELITE_APP_URL` | the app the login comes from; the only host an avatar URL may come from |
| `APP_URL` | this app's own address, for the sign-in round trip and the WebSocket origin check |
| `GATE_SECRET` | signs the 18+ unlock cookie |
| `IMPORT_CRON_SECRET` | what a background job presents when it loops back over HTTP |
| `ADULTS_EMAIL` | the account whose stories count as adult |
| `IG_COOKIES_PATH`, `IG_COOKIES_ROOT` | Instagram session cookies |
| `TIKTOK_COOKIES_PATH`, `TIKTOK_COOKIES_ROOT` | TikTok cookies (optional) |
| `YT_DLP_BIN`, `GALLERY_DL_BIN`, `PYTHON_BIN` | the downloaders the syncs shell out to |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push |
| `BACKUP_DIR`, `BACKUP_KEEP` | the nightly `VACUUM INTO` |

---

## Migrating from elite-v2

`scripts/migrate-from-elitev2.mjs <source.db> [dest.db]` seeds this database
from elite-v2's.

The source **must** be a snapshot taken with SQLite's `.backup` or
`VACUUM INTO`, not a copied file: elite-v2 runs in WAL mode, and a plain `cp` of
the `.db` without its `-wal` opens fine and reports zero rows.

Ids are preserved — a post's media, a like's `user_id`, a duplicate group's
`media_id` and every `storage_key` reference ids that exist on the other side.
Every insert is `INSERT OR IGNORE`, so a re-run is a top-up, not a mirror: it
adds what is missing and deletes nothing.

---

## Running it

```
npm install
npm run dev           # :3021
npm run build && npm start
```

`Dockerfile` builds a production image. `better-sqlite3` and `sharp` are native
and the maintenance scripts run inside the container (the scheduler spawns
them), so the image is built rather than bind-mounted.
