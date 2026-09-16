import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listNotifications,
  markAllRead,
  unreadCount,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * This account's activity: likes, comments, follows, mentions and
 * announcements.
 *
 * Read history is returned alongside the unread rows, so the list keeps an
 * "Earlier" section after a mark-all-read rather than emptying itself.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = Number(session.sub);
  return NextResponse.json({
    unreadCount: unreadCount(userId),
    notifications: listNotifications(userId),
  });
}

/** Mark everything read. */
export async function DELETE() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  markAllRead(Number(session.sub));
  return NextResponse.json({ ok: true });
}
