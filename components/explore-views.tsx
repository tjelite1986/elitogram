"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Hash, Shuffle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import PostViews from "@/components/post-views";
import type { LightboxViewer } from "@/components/post-lightbox";

type Media = "all" | "photos" | "videos";

// 1..2^31-1 — the API treats 0 as unset and falls back to its default seed.
const newSeed = () => Math.floor(Math.random() * 0x7ffffffe) + 1;

const CHIPS: { id: Media; label: string }[] = [
  { id: "all", label: "All" },
  { id: "photos", label: "Photos" },
  { id: "videos", label: "Videos" },
];

const EMPTY: Record<Media, string> = {
  all: "No posts to explore yet.",
  photos: "No photos to explore yet.",
  videos: "No videos to explore yet.",
};

// Explore's post list plus a media chip row (all / photos only / videos only),
// a shuffle toggle and a link to the tag index. Filters and sort are part of
// the feed query, so switching remounts the list (key) instead of appending
// one query's pages to another's; the choices are remembered per browser like
// the view switcher is.
//
// Shuffle exists because id order deep in Explore is long one-creator import
// blocks (review finding 33). The seed lives in sessionStorage: stable while
// paging and across a round trip into a post (pages never overlap), fresh on
// the next visit. Tapping Shuffle while it is active deals a new order.
export default function ExploreViews({ viewer }: { viewer?: LightboxViewer }) {
  const [media, setMedia] = useState<Media>("all");
  const [seed, setSeed] = useState<number | null>(null);
  // Wait for the saved filter before mounting the list, so we never fetch one
  // filter's first page and immediately throw it away for another.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("posts-media-explore");
      if (saved === "all" || saved === "photos" || saved === "videos") {
        setMedia(saved);
      }
      if (window.localStorage.getItem("posts-sort-explore") === "shuffle") {
        const s = Number(window.sessionStorage.getItem("posts-shuffle-seed"));
        const kept = Number.isInteger(s) && s > 0 ? s : newSeed();
        window.sessionStorage.setItem("posts-shuffle-seed", String(kept));
        setSeed(kept);
      }
    } catch {
      /* private mode etc. — keep the default */
    }
    setReady(true);
  }, []);

  const pick = (m: Media) => {
    setMedia(m);
    try {
      window.localStorage.setItem("posts-media-explore", m);
    } catch {
      /* non-persistent is fine */
    }
  };

  // Off -> on deals an order; on -> tap again reshuffles; the X on the active
  // chip is the way back to newest-first.
  const toggleShuffle = (on: boolean) => {
    const next = on ? newSeed() : null;
    setSeed(next);
    try {
      window.localStorage.setItem("posts-sort-explore", on ? "shuffle" : "new");
      if (next) window.sessionStorage.setItem("posts-shuffle-seed", String(next));
      else window.sessionStorage.removeItem("posts-shuffle-seed");
    } catch {
      /* non-persistent is fine */
    }
  };

  const chips = (
    // Three groups no longer fit a 390px row beside the view switcher, so the
    // chip row scrolls sideways instead of pushing the switcher off screen.
    <div
      className="mr-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      <div className="flex shrink-0 items-center gap-1 rounded-full bg-white/5 p-0.5">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            onClick={() => pick(c.id)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-semibold transition",
              media === c.id
                ? "bg-white/15 text-white"
                : "text-white/40 hover:text-white/70"
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center rounded-full",
          seed !== null ? "bg-white/15" : "bg-white/5"
        )}
      >
        <button
          onClick={() => toggleShuffle(true)}
          title={seed !== null ? "Shuffle again" : "Shuffle the library"}
          className={cn(
            "flex items-center gap-1 rounded-full py-1.5 pl-3 text-xs font-semibold transition",
            seed !== null ? "pr-1 text-white" : "pr-3 text-white/40 hover:text-white/70"
          )}
        >
          <Shuffle size={13} /> Shuffle
        </button>
        {seed !== null && (
          <button
            onClick={() => toggleShuffle(false)}
            aria-label="Back to newest first"
            className="rounded-full p-1.5 text-white/50 transition hover:text-white"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <Link
        href="/tags"
        className="flex shrink-0 items-center gap-1 rounded-full bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/40 transition hover:text-white/70"
      >
        <Hash size={13} /> Tags
      </Link>
    </div>
  );

  if (!ready) return null;

  const query: Record<string, string> = { scope: "explore" };
  if (media !== "all") query.media = media;
  if (seed !== null) {
    query.sort = "shuffle";
    query.seed = String(seed);
  }
  // The seed is part of the identity: a new deal remounts the list, and the
  // scroll-restore cache from an old deal can never resume the new one.
  const ident = `${media}:${seed ?? "new"}`;

  return (
    <PostViews
      key={ident}
      query={query}
      empty={EMPTY[media]}
      viewer={viewer}
      storageKey="posts-view-explore"
      defaultView="grid"
      restoreKey={`posts:explore:${ident}`}
      leading={chips}
    />
  );
}
