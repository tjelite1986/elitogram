import { NextResponse } from "next/server";
import { sql } from "kysely";
import { qb, getAll } from "@/lib/kysely";
import { getSession } from "@/lib/auth";
import { has18Access } from "@/lib/adult-gate";
import { handleOf } from "@/lib/directory";

export const dynamic = "force-dynamic";

// Search accounts (users + mirrored photo AND video creators), hashtags and
// captions. Account search is a substring LIKE over username/name +
// display_name; tags over post_hashtags; captions via posts_fts (LIKE when the
// SQLite build lacks FTS5). Accounts are deduped by handle (a person with both
// photos appears once).
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (new URL(request.url).searchParams.get("q") || "").trim().toLowerCase();
  // Floor of 2: a single character LIKE-scans the whole hashtag table for
  // matches nobody is looking for yet.
  if (q.length < 2) {
    return NextResponse.json({ accounts: [], tags: [], posts: [] });
  }
  const like = `%${q.replace(/[%_]/g, "")}%`;

  const users = getAll<{ username: string; display_name: string | null }>(
    qb
      .selectFrom("user_profiles")
      .select(["username", "display_name"])
      .where(sql<boolean>`(username LIKE ${like} OR LOWER(display_name) LIKE ${like})`)
      .orderBy("username")
      .limit(10)
  );

  // Without 18+ access, adult-only creator names and tags must not surface —
  // even the name is a leak.
  const adult = await has18Access();

  let creatorsQuery = qb
    .selectFrom("post_creators")
    .select(["username", "display_name"])
    .where(sql<boolean>`(username LIKE ${like} OR LOWER(display_name) LIKE ${like})`)
    .orderBy("username")
    .limit(10);
  if (!adult) {
    creatorsQuery = creatorsQuery.where("is_adult", "=", 0);
  }
  const creators = getAll<{ username: string; display_name: string | null }>(creatorsQuery);

  let tagsQuery = qb
    .selectFrom("post_hashtags")
    .innerJoin("posts", "posts.id", "post_hashtags.post_id")
    .select((eb) => ["tag", eb.fn.countAll<number>().as("count")])
    .where("tag", "like", like)
    .where("posts.is_deleted", "=", 0)
    .groupBy("tag")
    .orderBy("count", "desc")
    .limit(10);
  if (!adult) {
    tagsQuery = tagsQuery.where("posts.is_adult", "=", 0);
  }
  const tags = getAll<{ tag: string; count: number }>(tagsQuery);

  // Captions. Floor of 3 because a 2-character term matches half the library.
  // The hashtags inside captions are already covered by the tag query above,
  // so this exists for the free prose (~15% of posts carry any caption).
  interface PostHit {
    id: number;
    caption: string | null;
    media_id: number | null;
  }
  let posts: PostHit[] = [];
  if (q.length >= 3) {
    const buildPostsQuery = (captionFilter: ReturnType<typeof sql<boolean>>) => {
      let query = qb
        .selectFrom("posts")
        .select(["id", "caption"])
        .select(
          sql<number | null>`(SELECT pm.id FROM post_media pm WHERE pm.post_id = posts.id ORDER BY pm.position LIMIT 1)`.as(
            "media_id"
          )
        )
        .where("is_deleted", "=", 0)
        .where(captionFilter)
        .orderBy("id", "desc")
        .limit(10);
      if (!adult) {
        query = query.where("is_adult", "=", 0);
      }
      return query;
    };
    try {
      // Phrase-prefix match; internal quotes doubled so user input can never
      // become FTS5 syntax (a bare parenthesis is a syntax error there).
      const match = `"${q.replace(/"/g, '""')}"*`;
      posts = getAll<PostHit>(
        buildPostsQuery(
          sql<boolean>`posts.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ${match})`
        )
      );
    } catch {
      // FTS5 unavailable in this SQLite build — substring LIKE over the ~7k
      // captions is a few milliseconds.
      posts = getAll<PostHit>(
        buildPostsQuery(sql<boolean>`LOWER(posts.caption) LIKE ${like}`)
      );
    }
  }

  // Dedupe by handle, preferring a real user over a mirrored creator.
  const byHandle = new Map<string, { username: string; display_name: string | null; type: "user" | "creator" }>();
  const add = (username: string, display_name: string | null, type: "user" | "creator") => {
    const h = handleOf(username);
    if (h && !byHandle.has(h)) byHandle.set(h, { username, display_name, type });
  };
  for (const u of users) add(u.username, u.display_name, "user");
  for (const c of creators) add(c.username, c.display_name, "creator");

  return NextResponse.json({ accounts: Array.from(byHandle.values()).slice(0, 20), tags, posts });
}
