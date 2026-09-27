import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loginUrl } from "@/lib/sso";
import { has18Access } from "@/lib/adult-gate";
import { getTagIndex } from "@/lib/posts";
import TagIndex from "@/components/tag-index";

export const dynamic = "force-dynamic";

// Tag index: hashtags with their live post counts, most-used first. Search
// only surfaces a tag you already know to type; this is the browsable
// version. The page renders the top slice and the client loads the long tail
// on demand — all ~1800 tags server-rendered cost 831 kB (each chip appears
// in both the HTML and the RSC payload), and the tail is mostly count-1 tags.
const PAGE_CAP = 150;

export default async function TagsPage() {
  const session = await getSession();
  if (!session) redirect(loginUrl());
  const adult = await has18Access();

  const tags = getTagIndex(adult);

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
        <TagIndex initial={tags.slice(0, PAGE_CAP)} total={tags.length} />
      )}
    </div>
  );
}
