import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

// Resolve the data directory (mounted as a named volume in Docker).
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "elitogram.db");

// Reuse a single connection across hot reloads in dev.
const globalForDb = globalThis as unknown as { db?: Database.Database };

function createDb(): Database.Database {
  const db = new Database(DB_PATH);
  // Wait for a busy DB instead of failing immediately. Must be set before the
  // journal_mode switch: on a fresh file, parallel `next build` workers race on
  // the WAL switch itself (it takes a write lock), and without a timeout the
  // losers fail instantly with SQLITE_BUSY. The timeout has to cover a
  // CUMULATIVE wait, not one critical section — the last worker queues behind
  // all the others.
  db.pragma("busy_timeout = 30000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Serialize the write-side of startup across processes: `next build` collects
  // page data in several workers, each of which initialises the same fresh file,
  // and without a lock they race on `ALTER TABLE ADD COLUMN`.
  db.exec("BEGIN IMMEDIATE");
  try {
    migrate(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    -- Accounts are MIRRORED, not owned. Elitogram has no login of its own: the
    -- session cookie is minted by elite-v2 and resolved there (lib/sso.ts), and
    -- this row is what lets a like or a comment render a name without a second
    -- round trip. It carries no password — that credential never leaves the app
    -- that issues it. \`adult_pin_hash\` IS local: the personal 18+ PIN gates
    -- surfaces on THIS host, so the hash it is checked against lives here and is
    -- never overwritten by a mirror refresh.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user',
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      adult_pin_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      synced_at TEXT,
      last_seen TEXT
    );

    -- Shared public profile layer (1:1 with users): the handle a person's posts
    -- are filed under, rather than the email's local part.
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_key TEXT,
      bio TEXT,
      show_adult_outside INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Mirrored creators imported from disk or synced from Instagram/TikTok.
    -- NOT user accounts.
    CREATE TABLE IF NOT EXISTS post_creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_key TEXT,
      bio TEXT,
      source TEXT NOT NULL DEFAULT 'import',
      is_adult INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_user_id INTEGER REFERENCES users(id),
      author_creator_id INTEGER REFERENCES post_creators(id),
      caption TEXT,
      is_adult INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER NOT NULL DEFAULT 0,
      CHECK ((author_user_id IS NULL) <> (author_creator_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(is_deleted, created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_author_user ON posts(author_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_author_creator ON posts(author_creator_id, created_at);

    -- Carousel media for a post, ordered by position. media_version busts the
    -- by-id media URL cache after a re-crop.
    CREATE TABLE IF NOT EXISTS post_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      media_version INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id, position);
    CREATE INDEX IF NOT EXISTS idx_post_media_hash ON post_media(content_hash);

    -- Duplicate-image grouping, written by scripts/scan-posts-duplicates.mjs for
    -- admin review under Settings; the scan itself deletes nothing. One row per
    -- image in a group, tied together by group_key, and the whole table is
    -- rewritten on each scan. Duplicates are scoped PER AUTHOR, so the same
    -- photo posted by two different people is not flagged as deletable.
    CREATE TABLE IF NOT EXISTS post_dupe_groups (
      group_key TEXT NOT NULL,
      media_id INTEGER NOT NULL REFERENCES post_media(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      match_type TEXT NOT NULL,            -- 'exact' | 'perceptual'
      quality_score REAL NOT NULL DEFAULT 0,
      is_best INTEGER NOT NULL DEFAULT 0,  -- the suggested image to keep
      distance INTEGER NOT NULL DEFAULT 0, -- dHash Hamming to the best (0 = exact)
      similarity INTEGER NOT NULL DEFAULT 0, -- SSIM % to the best (100 = identical)
      scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_key, media_id)
    );
    CREATE INDEX IF NOT EXISTS idx_post_dupe_media ON post_dupe_groups(media_id);

    -- Pairs an admin marked "not duplicates" so the perceptual matcher stops
    -- grouping them (a<b by media id). Exact byte-identical matches are never
    -- ignored — only the fuzzy perceptual ones.
    CREATE TABLE IF NOT EXISTS post_dupe_ignored (
      a_media_id INTEGER NOT NULL,
      b_media_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (a_media_id, b_media_id)
    );

    -- Single-row progress beacon for the duplicate scan, so the admin UI can
    -- poll while the detached scan runs.
    CREATE TABLE IF NOT EXISTS post_dupe_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'idle',  -- 'idle' | 'running' | 'done' | 'error'
      started_at TEXT,
      finished_at TEXT,
      scanned INTEGER NOT NULL DEFAULT 0,
      groups INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );

    -- Per-image fingerprint cache (sha256 + perceptual dHash) so repeat scans
    -- skip hashing images whose file size is unchanged.
    CREATE TABLE IF NOT EXISTS post_media_fp (
      media_id INTEGER PRIMARY KEY REFERENCES post_media(id) ON DELETE CASCADE,
      size_bytes INTEGER NOT NULL,
      sha TEXT,
      sig TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at);

    -- Polymorphic social graph: a user follows either another user or a creator.
    -- 'shorts' is still accepted so rows written before the clip libraries became
    -- their own apps stay valid; nothing creates one any more.
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id),
      target_type TEXT NOT NULL CHECK (target_type IN ('user','creator','shorts')),
      target_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(target_type, target_id);

    -- Ephemeral 24h stories (real accounts only).
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_user_id INTEGER NOT NULL REFERENCES users(id),
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      media_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);

    CREATE TABLE IF NOT EXISTS story_views (
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (story_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),       -- recipient
      type TEXT NOT NULL,                                  -- like|comment|follow|mention|system
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      post_id INTEGER,
      comment_id INTEGER,
      message TEXT,                                        -- system: free-text announcement
      href TEXT,                                           -- system: link target
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);

    CREATE TABLE IF NOT EXISTS post_hashtags (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (post_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_post_hashtags_tag ON post_hashtags(tag);

    -- Avatar chosen for a person, keyed by their shared handle so it works for
    -- every identity type. Takes precedence over the legacy avatar_key columns.
    CREATE TABLE IF NOT EXISTS handle_avatars (
      handle TEXT PRIMARY KEY,
      avatar_key TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Non-destructive profile links: a member handle is displayed under a
    -- primary "face" handle. Both keep their own rows and keep syncing
    -- independently. One level only (a member is never itself a primary).
    CREATE TABLE IF NOT EXISTS profile_links (
      member_handle TEXT PRIMARY KEY,
      primary_handle TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_profile_links_primary
      ON profile_links(primary_handle);

    -- Profile extras keyed by handle: bio, cover banner, a JSON array of
    -- labeled links, and the Instagram/TikTok sync config and status for this
    -- person. The remote source handle can differ from the local one; synced
    -- media is imported under the LOCAL handle so it attaches to THIS profile.
    CREATE TABLE IF NOT EXISTS profile_extras (
      handle TEXT PRIMARY KEY,
      bio TEXT,
      links_json TEXT,
      fields_json TEXT,
      location TEXT,
      banner_key TEXT,
      instagram_handle TEXT,
      ig_auto_poll INTEGER NOT NULL DEFAULT 0,
      ig_stories INTEGER NOT NULL DEFAULT 0,
      ig_highlights INTEGER NOT NULL DEFAULT 0,
      ig_last_synced_at TEXT,
      ig_last_sync_error TEXT,
      ig_syncing INTEGER NOT NULL DEFAULT 0,
      tiktok_handle TEXT,
      tt_auto_poll INTEGER NOT NULL DEFAULT 0,
      tt_last_synced_at TEXT,
      tt_last_sync_error TEXT,
      tt_syncing INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Admin-granted per-user capabilities (keys in lib/permissions.ts). A row's
    -- presence = granted; admins need no rows.
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, permission)
    );

    -- Web Push subscriptions (one row per browser/device endpoint), for
    -- notifications while the tab is closed.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

    -- Background-job scheduler rows, owned by lib/jobs-runtime.mjs.
    CREATE TABLE IF NOT EXISTS job_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_seconds INTEGER NOT NULL,
      last_run_at TEXT,
      last_status TEXT,
      last_duration_ms INTEGER,
      last_output TEXT,
      next_run_at TEXT,
      running INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Columns added after the first release. Each ALTER is guarded by reading the
  // schema rather than by a version number: the result of adding a column is
  // indistinguishable from it having always been there, so re-running is safe.
  const columns = (table: string): Set<string> => {
    try {
      const rows = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as { name: string }[];
      return new Set(rows.map((r) => r.name));
    } catch {
      return new Set();
    }
  };
  const addColumn = (table: string, column: string, spec: string) => {
    if (columns(table).has(column)) return;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
    } catch {
      /* raced with another worker that just added it */
    }
  };
  addColumn("post_media", "content_hash", "TEXT");
  addColumn("user_profiles", "show_adult_outside", "INTEGER NOT NULL DEFAULT 0");
  addColumn("users", "adult_pin_hash", "TEXT");

  // Caption search. Guarded because FTS5 is a compile-time option: without it
  // the search route falls back to LIKE, which is correct, only slower.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts
        USING fts5(caption, content='posts', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
        INSERT INTO posts_fts(rowid, caption) VALUES (new.id, new.caption);
      END;
      CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, caption) VALUES('delete', old.id, old.caption);
      END;
      CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, caption) VALUES('delete', old.id, old.caption);
        INSERT INTO posts_fts(rowid, caption) VALUES (new.id, new.caption);
      END;
    `);
    // A content-table index that was never populated (a database migrated in
    // from elsewhere, or created before FTS5 was available) answers every query
    // with nothing. Build it once when it is empty but posts are not.
    const indexed = db
      .prepare("SELECT count(*) AS c FROM posts_fts")
      .get() as { c: number };
    const captioned = db
      .prepare("SELECT count(*) AS c FROM posts WHERE caption IS NOT NULL")
      .get() as { c: number };
    if (indexed.c === 0 && captioned.c > 0) {
      db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')");
    }
  } catch {
    /* FTS5 unavailable — search uses a LIKE fallback */
  }
}

// A fresh database file can be initialised by several `next build` workers at
// once. The BEGIN IMMEDIATE in createDb serializes them, but a worker that
// times out waiting still throws — retry rather than fail the build.
function createDbWithRetry(attempts = 12, waitMs = 500): Database.Database {
  for (let i = 1; ; i++) {
    try {
      return createDb();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "SQLITE_BUSY" || i >= attempts) throw e;
      // Deliberately synchronous: this runs at module scope, so there is no
      // event loop to await on and the process has nothing else to do.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export const db = globalForDb.db ?? createDbWithRetry();
if (process.env.NODE_ENV !== "production") globalForDb.db = db;

/**
 * A mirrored account. There is no `password_hash`: elite-v2 owns the login, and
 * this row is refreshed from its verify answer on every request.
 */
export interface UserRow {
  id: number;
  email: string;
  role: "user" | "admin";
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  adult_pin_hash: string | null;
  created_at: string;
  synced_at: string | null;
  last_seen: string | null;
}

export interface UserProfileRow {
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  show_adult_outside: number;
  created_at: string;
}

export interface PostCreatorRow {
  id: number;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  source: string;
  is_adult: number;
  created_at: string;
}

export interface PostRow {
  id: number;
  author_user_id: number | null;
  author_creator_id: number | null;
  caption: string | null;
  is_adult: number;
  created_at: string;
  is_deleted: number;
}

export interface PostMediaRow {
  id: number;
  post_id: number;
  storage_key: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  position: number;
  media_version: number;
  content_hash: string | null;
}

export interface PostCommentRow {
  id: number;
  post_id: number;
  user_id: number;
  body: string;
  created_at: string;
}

export interface PostDupeStateRow {
  id: number;
  status: "idle" | "running" | "done" | "error";
  started_at: string | null;
  finished_at: string | null;
  scanned: number;
  groups: number;
  message: string | null;
}

// 'shorts' is still accepted by the follows CHECK so rows written before those
// libraries left stay valid; nothing creates one any more.
export type FollowTargetType = "user" | "creator";

export interface FollowRow {
  follower_id: number;
  target_type: FollowTargetType;
  target_id: number;
  created_at: string;
}

export interface StoryRow {
  id: number;
  author_user_id: number;
  storage_key: string;
  mime_type: string;
  media_version: number;
  created_at: string;
  expires_at: string;
}

export type NotificationType =
  | "like"
  | "comment"
  | "follow"
  | "mention"
  | "system";

export interface NotificationRow {
  id: number;
  user_id: number;
  type: NotificationType;
  actor_user_id: number;
  post_id: number | null;
  comment_id: number | null;
  message: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
}
