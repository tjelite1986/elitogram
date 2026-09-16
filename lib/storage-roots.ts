import fs from "node:fs";
import path from "node:path";

// Single source of truth for the storage roots. In production each is a
// bind-mounted host folder (see the compose file); the defaults under DATA_DIR
// keep dev and test self-contained.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

// The whole served library: creator folders, an account's own uploads under
// u_<user>/posts/, stories, avatars and banners.
export const POSTS_ROOT =
  process.env.POSTS_ROOT || path.join(DATA_DIR, "posts");

// True when the directory exists and holds at least one entry. A production
// media root is a bind mount that always has content, so a missing or empty
// root almost certainly means the volume is not mounted — callers must not
// treat "file not found" as meaningful in that state (an orphan scan would
// otherwise classify the entire library as deletable).
export function storageRootAvailable(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// --- Per-user home -------------------------------------------------------

// Filesystem-safe folder name for a name, so a folder always maps to one slug.
function slugify(name: string | null | undefined): string {
  const slug = (name || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
  return slug || "unknown";
}

// Per-user home folder name for an account (filesystem-safe), e.g. "u_anna".
// Falls back to the numeric id when the user has no username yet.
export function userHomeDir(userId: number, username?: string | null): string {
  const slug = username ? slugify(username) : "unknown";
  return `u_${slug && slug !== "unknown" ? slug : userId}`;
}
