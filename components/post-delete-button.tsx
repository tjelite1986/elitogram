"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";

// Delete a post (owner or admin). Confirms in a popup, then returns to the feed.
export default function PostDeleteButton({ postId }: { postId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, confirmAsk] = useConfirm();

  const remove = async () => {
    if (busy) return;
    const ok = await confirmAsk({
      title: "Delete this post?",
      message: "Its media files are removed. This can't be undone.",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${postId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Delete failed.");
    } catch {
      setError("Delete failed — check the connection.");
    }
    // A silent re-enable reads as "nothing happened" and invites a second
    // press; the message says what actually did.
    setBusy(false);
  };

  return (
    <>
      <span className="inline-flex items-center gap-2">
        {error && (
          <span role="alert" className="text-xs text-rose-400">
            {error}
          </span>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-sm text-rose-300 transition hover:text-rose-400 disabled:opacity-50"
        >
          <Trash2 size={15} /> Delete
        </button>
      </span>
      {confirmDialog}
    </>
  );
}
