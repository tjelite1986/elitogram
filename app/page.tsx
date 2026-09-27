import { redirect } from "next/navigation";
import Link from "next/link";
import { Compass } from "lucide-react";
import { getSession } from "@/lib/auth";
import { loginUrl } from "@/lib/sso";
import { ensureUserProfile } from "@/lib/profiles";
import { getFeed } from "@/lib/posts";
import PostViews from "@/components/post-views";
import StoryRail from "@/components/story-rail";

export const dynamic = "force-dynamic";

// Home feed: posts from the people/creators the viewer follows (plus their own).
// When that feed has nothing to show, the empty state stays visible (it explains
// how to fill this tab) and a labelled "Suggested" section renders the explore
// feed beneath it — the fallback is visible as a fallback, so Feed is never a
// dead screen but never silently becomes a second Explore tab either.
export default async function PostsHomePage() {
  const session = await getSession();
  if (!session) redirect(loginUrl());
  const viewerId = Number(session.sub);
  const profile = ensureUserProfile(viewerId, session.email);
  const viewer = { userId: viewerId, isAdmin: session.role === "admin" };
  // Adult posts count as content here: the follow feed is "empty" only when
  // nothing at all matches, not when everything sits behind the 18+ gate.
  const hasFollowedContent =
    getFeed({ kind: "home" }, viewerId, null, 1, true).items.length > 0;

  return (
    // Full-bleed feed: post photos span the whole screen edge to edge.
    <div className="mx-auto w-full max-w-6xl pb-24 pt-6 text-white">
      <StoryRail myUsername={profile.username} />
      {hasFollowedContent ? (
        <>
          <PostViews
            query={{ scope: "home" }}
            empty="Your feed is empty — follow people on Explore to see their posts here."
            viewer={viewer}
            storageKey="posts-view-home"
            restoreKey="posts:home"
          />
          <div className="mt-6 text-center">
            <Link
              href="/explore"
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold transition hover:bg-white/15"
            >
              <Compass size={16} /> Discover more
            </Link>
          </div>
        </>
      ) : (
        <>
          <div className="px-4 pb-10 pt-8 text-center">
            <p className="text-sm text-white/50">
              Your feed is empty — follow people on Explore to see their posts
              here.
            </p>
            <Link
              href="/explore"
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold transition hover:bg-white/15"
            >
              <Compass size={16} /> Discover more
            </Link>
          </div>
          <h2 className="mb-1 px-4 text-lg font-semibold">Suggested</h2>
          <PostViews
            query={{ scope: "explore" }}
            viewer={viewer}
            storageKey="posts-view-home-suggested"
            restoreKey="posts:home-suggested"
          />
        </>
      )}
    </div>
  );
}
