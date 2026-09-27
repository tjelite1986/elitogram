"use client";

import { useEffect, useRef } from "react";

// The two modal behaviors with real effect in this app (review finding 45):
// Escape closes the overlay, and the page behind it cannot scroll while one is
// open. A module-level stack means Escape only ever closes the TOPMOST overlay
// when they stack (a confirm popup over a comments sheet), and the scroll lock
// releases only when the last one is gone. The single listener runs in the
// BUBBLE phase on document: late enough that a control inside the overlay can
// keep Escape for itself with stopPropagation (MentionInput closing its
// @-suggestions), yet its own stopPropagation still fires before an underlying
// surface's window listener (the lightbox's Escape/arrow handler) sees the
// press. Focus trapping is deliberately left out — a hand-rolled trap on six
// overlays is more code than the payoff here.

type Entry = { close: () => void };

const stack: Entry[] = [];
let prevOverflow = "";

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.stopPropagation();
  top.close();
}

export function useModal(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const entry: Entry = { close: () => closeRef.current() };
    if (stack.length === 0) {
      document.addEventListener("keydown", onKey);
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) {
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prevOverflow;
      }
    };
  }, [open]);
}
