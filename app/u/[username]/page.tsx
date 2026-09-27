import { redirect } from "next/navigation";
import { handleOf } from "@/lib/directory";

export const dynamic = "force-dynamic";

// The old public profile route. The unified profile lives at /people/<handle>
// (one design, one page to improve); this only keeps old permalinks and
// bookmarks working. An unknown name 404s over there via resolvePerson.
export default async function PostsProfilePage(
  props: {
    params: Promise<{ username: string }>;
  }
) {
  const params = await props.params;
  redirect(`/people/${encodeURIComponent(handleOf(params.username))}`);
}
