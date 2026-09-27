import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { has18Access } from "@/lib/adult-gate";
import { getTagIndex } from "@/lib/posts";

export const dynamic = "force-dynamic";

// The full tag index as JSON — the "Show all" half of /tags. The page
// server-renders only the top slice (each chip costs ~0.5 kB twice over in
// HTML + RSC payload); the long tail comes from here at ~30 bytes per tag,
// and only when asked for. Same gate as the page: adult-only tags are absent
// without the 18+ PIN.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const adult = await has18Access();
  return NextResponse.json({ tags: getTagIndex(adult) });
}
