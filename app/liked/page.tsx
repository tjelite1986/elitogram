import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loginUrl } from "@/lib/sso";
import PostViews from "@/components/post-views";

export const dynamic = "force-dynamic";

// Every post the viewer has liked — the retrieval side of the heart. Without
// this page a like is a counter on the post and nothing else.
export default async function LikedPostsPage() {
  const session = await getSession();
  if (!session) redirect(loginUrl());

  return (
    <div className="mx-auto w-full max-w-6xl pb-24 pt-6 text-white">
      <h1 className="mb-4 px-3 text-lg font-semibold">Liked</h1>
      <PostViews
        query={{ scope: "liked" }}
        empty="Nothing liked yet — double-tap a post or press its heart and it lands here."
        viewer={{ userId: Number(session.sub), isAdmin: session.role === "admin" }}
        storageKey="posts-view-liked"
        restoreKey="posts:liked"
      />
    </div>
  );
}
