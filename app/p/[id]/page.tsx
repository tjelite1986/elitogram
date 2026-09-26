import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getSession } from "@/lib/auth";
import { loginUrl } from "@/lib/sso";
import { has18Access, hasAdultPin } from "@/lib/adult-gate";
import { getPost } from "@/lib/posts";
import AdultGate from "@/components/adult-gate";
import PostCard from "@/components/post-card";
import PostDeleteButton from "@/components/post-delete-button";
import PostReassignButton from "@/components/post-reassign-button";

export const dynamic = "force-dynamic";

// A single post permalink.
export default async function PostPermalinkPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const session = await getSession();
  if (!session) redirect(loginUrl());
  const viewerId = Number(session.sub);

  const post = getPost(Number(params.id), viewerId);
  if (!post) notFound();
  if (post.is_adult && !(await has18Access())) {
    // Locked 18+ post: show the PIN prompt in place. On a correct PIN the
    // unlock route sets the gate cookie and the refresh re-renders this page
    // with the post. (The old redirect went to /videos18, a route that never
    // existed in this app.)
    return <AdultGate configured={await hasAdultPin()} />;
  }

  const isAdmin = session.role === "admin";
  const canDelete =
    isAdmin || (post.author.type === "user" && post.author.id === viewerId);

  return (
    // Same measure as the capped feed card (PostCard maxes at 600px), so the
    // Back/Delete row hugs the post instead of spanning the whole desktop.
    <div className="mx-auto w-full max-w-2xl pb-24 pt-6 text-white">
      <div className="mb-2 flex items-center justify-between gap-3 px-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-white/60 hover:text-white"
        >
          <ChevronLeft size={16} /> Back
        </Link>
        <div className="flex items-center gap-4">
          {isAdmin && (
            <PostReassignButton
              postId={post.id}
              currentCreatorId={post.author.type === "creator" ? post.author.id : null}
            />
          )}
          {canDelete && <PostDeleteButton postId={post.id} />}
        </div>
      </div>
      <PostCard post={post} />
    </div>
  );
}
