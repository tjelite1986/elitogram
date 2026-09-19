"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

function initials(name: string | null): string {
  const s = (name || "?").replace(/[^a-zA-Z0-9]/g, "");
  return (s.slice(0, 2) || "?").toUpperCase();
}

// A static query so the avatar URL differs from the pre-ETag-fix one that
// browsers cached under a 24h max-age — they'd otherwise keep serving the stale
// picture for up to a day. Bump if a similar mass cache-bust is ever needed.
const CACHE_BUST = "2";

// Round avatar for a user/creator handle. The initials are always rendered
// underneath; the picture is laid over them and only becomes visible once it
// has actually loaded, so a handle with no avatar shows initials and never the
// browser's broken-image glyph.
export default function PostAvatar({
  username,
  size = 36,
  className,
  version,
  hasAvatar,
}: {
  username: string | null;
  size?: number;
  className?: string;
  // Bump to bust the avatar's 24h cache after it's changed (the URL is keyed by
  // username, so without this a new picture keeps showing the cached old one).
  version?: number;
  // What the caller already knows. `false` skips the request entirely: the
  // people directory and the feed both resolve it in the query that fetched the
  // row, and asking again costs a 404 per avatar-less handle (55 of them on one
  // /people screen). Leave it out where the answer isn't known, or where the
  // picture can be uploaded without the caller's copy of the row being refetched
  // — an `undefined` here only costs a request that falls back to initials.
  hasAvatar?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const showImg = Boolean(username) && hasAvatar !== false && !failed;
  const src =
    `/api/profiles/${encodeURIComponent(username || "")}/avatar?c=${CACHE_BUST}` +
    (version ? `&v=${version}` : "");

  // An <img> that finishes — or 404s — before React hydrates fires neither
  // onLoad nor onError, and the outcome would be lost: the picture would stay
  // transparent, or a dead one would keep its slot. So the element is asked
  // directly. A complete image with no intrinsic width is a broken one.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (!img.complete) {
      setLoaded(false);
      setFailed(false);
      return;
    }
    setLoaded(img.naturalWidth > 0);
    setFailed(img.naturalWidth === 0);
  }, [src]);

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-rose-500/70 to-purple-600/70 text-xs font-semibold text-white",
        className
      )}
      style={{ width: size, height: size }}
    >
      {initials(username)}
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={src}
          alt=""
          width={size}
          height={size}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
