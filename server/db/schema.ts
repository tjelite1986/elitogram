// Each entry is one migration; the index + 1 is stored in PRAGMA user_version.
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    permissions TEXT NOT NULL DEFAULT '[]',
    avatar_path TEXT,
    pin_hash TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE badges (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#3b82f6'
  );
  CREATE TABLE user_badges (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, badge_id)
  );

  CREATE TABLE creators (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT '[]',
    avatar_path TEXT,
    banner_path TEXT,
    ig_handle TEXT,
    tiktok_handle TEXT,
    ig_autopoll INTEGER NOT NULL DEFAULT 0,
    tiktok_autopoll INTEGER NOT NULL DEFAULT 0,
    adult INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER,
    last_sync_result TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE creator_aliases (
    alias TEXT PRIMARY KEY COLLATE NOCASE,
    creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE
  );
  CREATE INDEX creator_aliases_creator ON creator_aliases(creator_id);

  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    creator_id INTEGER REFERENCES creators(id),
    user_id INTEGER REFERENCES users(id),
    uploader_id INTEGER REFERENCES users(id),
    caption TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    source_url TEXT,
    source_key TEXT UNIQUE,
    adult INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    CHECK (creator_id IS NOT NULL OR user_id IS NOT NULL)
  );
  CREATE INDEX posts_created ON posts(deleted, created_at DESC);
  CREATE INDEX posts_creator ON posts(creator_id, created_at DESC);
  CREATE INDEX posts_user ON posts(user_id, created_at DESC);

  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    position INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK (kind IN ('image','video')),
    mime TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration REAL,
    sha256 TEXT,
    phash TEXT,
    missing INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX media_post ON media(post_id, position);
  CREATE INDEX media_sha ON media(sha256);
  CREATE INDEX media_kind ON media(kind);

  CREATE TABLE hashtags (
    id INTEGER PRIMARY KEY,
    tag TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE post_hashtags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, hashtag_id)
  );
  CREATE INDEX post_hashtags_tag ON post_hashtags(hashtag_id);

  CREATE TABLE likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE INDEX likes_post ON likes(post_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_post ON comments(post_id, created_at);

  CREATE TABLE follows (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, creator_id)
  );

  CREATE TABLE stories (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image','video')),
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    adult INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    expired INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX stories_active ON stories(expired, expires_at);
  CREATE TABLE story_views (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, user_id)
  );

  CREATE TABLE dup_groups (
    id INTEGER PRIMARY KEY,
    signature TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ignored','resolved')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE dup_members (
    group_id INTEGER NOT NULL REFERENCES dup_groups(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    distance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, media_id)
  );

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    creator_id INTEGER REFERENCES creators(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE jobs (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_minutes INTEGER NOT NULL,
    last_run_at INTEGER,
    next_run_at INTEGER,
    last_status TEXT,
    last_result TEXT
  );

  CREATE TABLE cookies (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    file TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER,
    last_used_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE search_fts USING fts5(caption, names, tags, tokenize = 'unicode61 remove_diacritics 2');
  `,
  // Imports once stored file mtimes with fractional milliseconds, which broke paging.
  `UPDATE posts SET created_at = CAST(ROUND(created_at) AS INTEGER) WHERE typeof(created_at) = 'real';`,
  // Grabbit 3.0 phase 2 (additive only): an audience per creator, post and
  // story ('unknown' until someone classifies it by hand; 18+ stays the adult
  // flag), Grabbit's delivery metadata per post, and the viewer's collections,
  // favorites and viewing history. Older images ignore the new columns.
  `
  ALTER TABLE creators ADD COLUMN audience TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE posts ADD COLUMN audience TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE posts ADD COLUMN meta TEXT;
  ALTER TABLE stories ADD COLUMN audience TEXT NOT NULL DEFAULT 'unknown';

  CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, post_id)
  );
  CREATE INDEX collection_items_post ON collection_items(post_id);
  CREATE TABLE favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE INDEX favorites_user ON favorites(user_id, created_at DESC);
  CREATE TABLE post_views (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE INDEX post_views_user ON post_views(user_id, viewed_at DESC);
  CREATE INDEX creators_audience ON creators(audience);
  `,
  // Grabbit 3.0 phase 2 (additive): where a creator's avatar and banner came from.
  // 'profile' = the creator's own platform profile picture; 'chosen' = uploaded by
  // a moderator; 'post:<media identity>' (id plus a hash of the bytes, see
  // mediaIdentity) = a crop of that media item; NULL = unknown (older crops). A scoped request is only
  // given a picture whose source is known and still in scope.
  `
  ALTER TABLE creators ADD COLUMN avatar_source TEXT;
  ALTER TABLE creators ADD COLUMN banner_source TEXT;
  `,
  // Grabbit 3.0 phase 2 (additive): a revision of everything that decides what a
  // scope can see. Triggers bump it in the same transaction as the change, from
  // any code path (routes, importer, jobs, an older image after a rollback), so
  // the categories cache can key on it instead of an aggregate that can collide.
  `
  CREATE TABLE visibility_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
  INSERT INTO visibility_rev (id, rev) VALUES (1, 0);
  CREATE TRIGGER vis_posts_ins AFTER INSERT ON posts BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_posts_del AFTER DELETE ON posts BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_posts_upd AFTER UPDATE OF adult, audience, deleted, creator_id ON posts BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_creators_ins AFTER INSERT ON creators BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_creators_del AFTER DELETE ON creators BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_creators_upd AFTER UPDATE OF adult, audience, deleted ON creators BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_media_ins AFTER INSERT ON media BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_media_del AFTER DELETE ON media BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_media_upd AFTER UPDATE OF missing, post_id, kind, width, height, position ON media BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_tags_ins AFTER INSERT ON post_hashtags BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  CREATE TRIGGER vis_tags_del AFTER DELETE ON post_hashtags BEGIN UPDATE visibility_rev SET rev = rev + 1 WHERE id = 1; END;
  `,
  // Grabbit 3.0.3 (additive): creators a caption mentions (@name), apart from
  // the post's own creator, and where a creator row came from ('mention' = made
  // for an @name nobody had; NULL = every older way). A mentioned creator only
  // finds the post through this table: the post, its files and its author stay
  // as they are.
  `
  ALTER TABLE creators ADD COLUMN origin TEXT;
  CREATE TABLE post_mentions (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY (post_id, creator_id)
  );
  CREATE INDEX post_mentions_creator ON post_mentions(creator_id, post_id);
  `,
  // Grabbit 3.0.4 (additive): a per-creator identity sequence. Every change to
  // what a creator is judged on (handle, deletion, classification, origin, sync
  // handles, links, aliases) raises it, and it never goes back, so an edit and
  // its revert never recreate an earlier value. Grabbit's gateway binds a post
  // move to the value it checked. Triggers keep it current for every writer,
  // including older code after a rollback (which ignores the column).
  `
  ALTER TABLE creators ADD COLUMN ident_seq INTEGER NOT NULL DEFAULT 0;
  CREATE TRIGGER ident_creator_upd AFTER UPDATE OF handle, deleted, adult, audience, origin, ig_handle, tiktok_handle, links ON creators
    BEGIN UPDATE creators SET ident_seq = ident_seq + 1 WHERE id = NEW.id; END;
  CREATE TRIGGER ident_alias_ins AFTER INSERT ON creator_aliases
    BEGIN UPDATE creators SET ident_seq = ident_seq + 1 WHERE id = NEW.creator_id; END;
  CREATE TRIGGER ident_alias_del AFTER DELETE ON creator_aliases
    BEGIN UPDATE creators SET ident_seq = ident_seq + 1 WHERE id = OLD.creator_id; END;
  CREATE TRIGGER ident_alias_upd AFTER UPDATE ON creator_aliases
    BEGIN UPDATE creators SET ident_seq = ident_seq + 1 WHERE id IN (OLD.creator_id, NEW.creator_id); END;
  `,
];
