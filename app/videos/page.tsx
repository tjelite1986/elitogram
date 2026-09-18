import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loginUrl } from "@/lib/sso";
import { ensureUserProfile } from "@/lib/profiles";
import VideosViews from "@/components/videos-views";

export const dynamic = "force-dynamic";

// Videos: every post that carries video media (Instagram videos and other clips
// that don't belong in Shorts), presented in the same immersive vertical-swipe
// view as the Shorts feed.
export default async function PostsVideosPage(props: {
  // ?focus=<post id>: a clip tapped in the grid view, opened in the immersive
  // feed. Read here rather than with useSearchParams so the client component
  // needs no Suspense boundary.
  searchParams: Promise<{ focus?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect(loginUrl());
  ensureUserProfile(Number(session.sub), session.email);
  const { focus } = await props.searchParams;
  const focusPostId = Number(focus) > 0 ? Number(focus) : undefined;

  return (
    <VideosViews
      viewer={{ userId: Number(session.sub), isAdmin: session.role === "admin" }}
      storageKey="videos-view"
      restoreKey="posts:videos"
      focusPostId={focusPostId}
    />
  );
}
