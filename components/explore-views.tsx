"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Hash } from "lucide-react";
import { cn } from "@/lib/utils";
import PostViews from "@/components/post-views";
import type { LightboxViewer } from "@/components/post-lightbox";

type Media = "all" | "photos" | "videos";

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

// Explore's post list plus a media chip row (all / photos only / videos only)
// and a link to the tag index. The filter is part of the feed query, so
// switching remounts the list (key) instead of appending one filter's pages to
// another's; the choice is remembered per browser like the view switcher is.
export default function ExploreViews({ viewer }: { viewer?: LightboxViewer }) {
  const [media, setMedia] = useState<Media>("all");
  // Wait for the saved filter before mounting the list, so we never fetch one
  // filter's first page and immediately throw it away for another.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("posts-media-explore");
      if (saved === "all" || saved === "photos" || saved === "videos") {
        setMedia(saved);
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

  const chips = (
    <div className="flex items-center gap-1">
      <div className="flex items-center gap-1 rounded-full bg-white/5 p-0.5">
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
      <Link
        href="/tags"
        className="flex items-center gap-1 rounded-full bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/40 transition hover:text-white/70"
      >
        <Hash size={13} /> Tags
      </Link>
    </div>
  );

  if (!ready) return null;

  return (
    <PostViews
      key={media}
      query={media === "all" ? { scope: "explore" } : { scope: "explore", media }}
      empty={EMPTY[media]}
      viewer={viewer}
      storageKey="posts-view-explore"
      defaultView="grid"
      restoreKey={media === "all" ? "posts:explore" : `posts:explore:${media}`}
      leading={chips}
    />
  );
}
