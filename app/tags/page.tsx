import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loginUrl } from "@/lib/sso";
import { has18Access } from "@/lib/adult-gate";
import { qb, getAll } from "@/lib/kysely";

export const dynamic = "force-dynamic";

// Tag index: every hashtag in the library with its live post count, most-used
// first. Search only surfaces a tag you already know to type; this is the
// browsable version. Without 18+ access, posts behind the gate do not count
// and adult-only tags disappear entirely — even the name is a leak.
export default async function TagsPage() {
  const session = await getSession();
  if (!session) redirect(loginUrl());
  const adult = await has18Access();

  let q = qb
    .selectFrom("post_hashtags")
    .innerJoin("posts", "posts.id", "post_hashtags.post_id")
    .select((eb) => ["tag", eb.fn.countAll<number>().as("count")])
    .where("posts.is_deleted", "=", 0)
    .groupBy("tag")
    .orderBy("count", "desc")
    .orderBy("tag");
  if (!adult) {
    q = q.where("posts.is_adult", "=", 0);
  }
  const tags = getAll<{ tag: string; count: number }>(q);

  return (
    <div className="mx-auto max-w-4xl px-3 pb-24 pt-6 text-white">
      <h1 className="mb-4 text-lg font-semibold">
        Tags <span className="font-normal text-white/40">{tags.length}</span>
      </h1>
      {tags.length === 0 ? (
        <p className="px-1 py-16 text-center text-sm text-white/50">
          No tags yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <Link
              key={t.tag}
              href={`/tag/${encodeURIComponent(t.tag)}`}
              className="rounded-full bg-white/5 px-3 py-1.5 text-sm transition hover:bg-white/15"
            >
              #{t.tag} <span className="text-white/40">{t.count}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
