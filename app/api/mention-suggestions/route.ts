import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Typeahead for @mentions (components/mention-input.tsx). One indexed prefix
// query per keystroke — deliberately NOT getPeople(), which builds the whole
// directory in memory and is far too heavy to fire every 120 ms of typing.
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (new URL(request.url).searchParams.get("q") || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "");
  if (!q) return NextResponse.json({ suggestions: [] });

  const suggestions = db
    .prepare(
      `SELECT username, display_name FROM user_profiles WHERE username LIKE ? || '%'
       UNION
       SELECT username, display_name FROM post_creators WHERE username LIKE ? || '%'
       ORDER BY username LIMIT 8`
    )
    .all(q, q) as { username: string; display_name: string | null }[];

  return NextResponse.json({ suggestions });
}
