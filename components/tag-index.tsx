"use client";

import { useState } from "react";
import Link from "next/link";

export interface TagCount {
  tag: string;
  count: number;
}

// The /tags chip list. The server hands over only the top slice; the long
// tail (mostly count-1 tags) loads from /api/tags when the reader actually
// asks for it, which keeps the page payload capped.
export default function TagIndex({
  initial,
  total,
}: {
  initial: TagCount[];
  total: number;
}) {
  const [tags, setTags] = useState(initial);
  const [loading, setLoading] = useState(false);

  const showAll = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tags");
      if (res.ok) {
        const d = await res.json();
        if (Array.isArray(d.tags)) setTags(d.tags);
      }
    } catch {
      /* keep the slice; the button stays for another try */
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
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
      {tags.length < total && (
        <button
          onClick={showAll}
          disabled={loading}
          className="mt-4 w-full rounded-full bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
        >
          {loading ? "Loading…" : `Show all ${total} tags`}
        </button>
      )}
    </>
  );
}
