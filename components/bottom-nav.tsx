"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Compass,
  Clapperboard,
  Users,
  Menu,
  PlusSquare,
  User,
  Images,
  Settings,
  ArrowLeft,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBackDismiss } from "@/lib/use-back-dismiss";

// The four tabs, plus a Menu button for everything that does not earn one.
// elite-v2 carried these in its own global bar; standing alone, the app has to
// draw its own — and this is the whole of it, rather than a copy of a
// context-sensitive menu that would have published another site's structure.
const TABS = [
  { label: "Feed", href: "/", icon: Home },
  { label: "Explore", href: "/explore", icon: Compass },
  { label: "Videos", href: "/videos", icon: Clapperboard },
  { label: "People", href: "/people", icon: Users },
] as const;

interface MenuLink {
  label: string;
  href: string;
  icon: typeof User;
}

export default function BottomNav({
  isAdmin = false,
  handle,
  eliteUrl,
  children,
}: {
  isAdmin?: boolean;
  handle: string;
  /** Where the login comes from — the door back to it. Absent when unset. */
  eliteUrl?: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifCount, setNotifCount] = useState(0);

  // Close the sheet when a menu link navigates away.
  useEffect(() => setMenuOpen(false), [pathname]);
  useBackDismiss(menuOpen, () => setMenuOpen(false));

  const loadNotifCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) setNotifCount((await res.json()).unreadCount ?? 0);
    } catch {
      /* offline — the next tick tries again */
    }
  }, []);

  // Initial load plus light polling. The socket pushes the interesting case
  // (someone just liked something) immediately; the timer is what recovers
  // after a sleep or a dropped connection.
  useEffect(() => {
    loadNotifCount();
    const t = setInterval(loadNotifCount, 30000);
    return () => clearInterval(t);
  }, [loadNotifCount]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      try {
        socket = new WebSocket(`${proto}://${location.host}/api/ws`);
      } catch {
        return;
      }
      socket.onmessage = (event) => {
        try {
          if (JSON.parse(event.data)?.type === "notification") loadNotifCount();
        } catch {
          /* not ours */
        }
      };
      // Reconnect on drop, but slowly: an unreachable server must not turn into
      // a tight loop of handshakes.
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 15000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [loadNotifCount]);

  const links: MenuLink[] = [
    { label: "New post", href: "/create", icon: PlusSquare },
    { label: "My profile", href: `/people/${handle}`, icon: User },
    { label: "My posts", href: "/me", icon: Images },
    { label: "Settings", href: "/settings", icon: Settings },
  ];

  // Longest prefix wins, so /people does not light up on /p/12.
  const activeHref =
    [...TABS]
      .map((t) => t.href)
      .filter((h) => (h === "/" ? pathname === "/" : pathname.startsWith(h)))
      .sort((a, b) => b.length - a.length)[0] ?? null;

  // The Videos tab is an exact-viewport feed; bottom padding under it would
  // only add a dead scroll gap.
  const fullBleed = pathname === "/videos";

  return (
    <>
      <div
        className={cn(
          "pt-[env(safe-area-inset-top)]",
          !fullBleed && "pb-[calc(3.5rem+env(safe-area-inset-bottom))]"
        )}
      >
        {children}
      </div>

      {/* z-40: below every fullscreen overlay (lightbox and story viewer are
          z-50+) so they cover the bar; hidden during immersive playback by the
          body.shorts-immersive rule in globals.css. */}
      <nav
        data-immersive-hide
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-white/10 bg-black/60 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        {TABS.map(({ label, href, icon: Icon }) => {
          const active = !menuOpen && href === activeHref;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition",
                active ? "text-violet-400" : "text-white/50 hover:text-white/80"
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.4 : 2} />
              {label}
            </Link>
          );
        })}
        <button
          onClick={() => setMenuOpen(true)}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition",
            menuOpen ? "text-violet-400" : "text-white/50 hover:text-white/80"
          )}
        >
          <span className="relative">
            <Menu size={22} strokeWidth={menuOpen ? 2.4 : 2} />
            {notifCount > 0 && (
              <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                {notifCount > 99 ? "99+" : notifCount}
              </span>
            )}
          </span>
          Menu
        </button>
      </nav>

      {menuOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="rounded-t-2xl bg-neutral-900 pb-[env(safe-area-inset-bottom)] text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="font-semibold">@{handle}</span>
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu">
                <X size={20} />
              </button>
            </div>
            <div className="py-1">
              {links.map(({ label, href, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-3 px-5 py-3 text-sm transition hover:bg-white/5"
                >
                  <Icon size={18} className="text-white/60" />
                  {label}
                </Link>
              ))}
              {isAdmin && (
                <Link
                  href="/settings?section=library"
                  className="flex items-center gap-3 px-5 py-3 text-sm transition hover:bg-white/5"
                >
                  <Images size={18} className="text-white/60" />
                  Library tools
                </Link>
              )}
              {eliteUrl && (
                <>
                  <div className="my-1 border-t border-white/10" />
                  {/* A plain <a>: this address is not one of this app's routes,
                      and asking the router to resolve it would 404 here before
                      the browser ever left. */}
                  <a
                    href={eliteUrl}
                    className="flex items-center gap-3 px-5 py-3 text-sm transition hover:bg-white/5"
                  >
                    <ArrowLeft size={18} className="text-white/60" />
                    Back to Elite
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
