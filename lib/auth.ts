import { cookies, headers } from "next/headers";
import { db, type UserRow } from "./db";
import { qb, getOne } from "./kysely";
import { SESSION_COOKIE, verifyToken, VERIFY_TTL_MS, type Appearance } from "./sso";

/**
 * The session shape the rest of the app reads.
 *
 * `sub` is a string because that is what it was in elite-v2, where it came from
 * a JWT subject, and every caller already does `Number(session.sub)`. Keeping
 * the name and the type is what let the ported code stay unchanged.
 */
export interface Session {
  sub: string;
  email: string;
  role: "user" | "admin";
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  appearance?: Appearance;
}

/**
 * When each mirrored account was last written. In-process only, like the verify
 * cache it is pegged to.
 */
const mirroredAt = new Map<number, number>();

/**
 * Mirror the account elite-v2 just vouched for.
 *
 * The row is what lets a like or a comment render a name without a second round
 * trip, and it is refreshed rather than written once: a rename over there has to
 * reach the posts filed under the old name.
 *
 * It is NOT refreshed on every call. getSession() runs ~100 times per page view
 * — once per server component, once per media byte served — and this wrote the
 * same unchanged row every time: a hundred serialized SQLite write transactions
 * per page, contending with the job scheduler on the same file. The row can
 * never be fresher than the verify that feeds it, so it is refreshed on that
 * same window (VERIFY_TTL_MS) and skipped in between.
 *
 * `adult_pin_hash` is deliberately absent from the UPDATE. The PIN gates
 * surfaces on THIS host and is set on this host, so a mirror refresh must never
 * clear it. The public handle a person's posts are filed under is not written
 * here either — `ensureUserProfile` owns `user_profiles`, and a rename made
 * here must survive the next request.
 */
function mirrorUser(user: {
  id: number;
  email: string;
  role: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}): void {
  const now = Date.now();
  const last = mirroredAt.get(user.id);
  if (last !== undefined && now - last < VERIFY_TTL_MS) return;
  // Stamp before the write, not after: a throw must not turn every subsequent
  // request into another attempt at the same failing statement.
  mirroredAt.set(user.id, now);
  for (const [id, at] of mirroredAt) {
    if (now - at >= VERIFY_TTL_MS) mirroredAt.delete(id);
  }
  mirrorStatement().run(
    user.id,
    user.email,
    user.role,
    user.username ?? null,
    user.displayName ?? null,
    user.avatarUrl ?? null
  );
}

/**
 * Prepared once and reused. db.prepare() re-parses the statement on every call,
 * which is the other half of what made the mirror expensive.
 */
type MirrorBind = [number, string, string, string | null, string | null, string | null];
let mirrorStmt: ReturnType<typeof db.prepare<MirrorBind>> | null = null;
function mirrorStatement() {
  if (!mirrorStmt) {
    mirrorStmt = db.prepare<MirrorBind>(
      `INSERT INTO users (id, email, role, username, display_name, avatar_url, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         role = excluded.role,
         username = COALESCE(excluded.username, users.username),
         display_name = COALESCE(excluded.display_name, users.display_name),
         avatar_url = excluded.avatar_url,
         synced_at = excluded.synced_at`
    );
  }
  return mirrorStmt;
}

/**
 * Read the current session from the request cookies. Works in server components
 * and route handlers alike (Node runtime, not edge).
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await verifyToken(token);
  if (!user) return null;
  mirrorUser(user);
  return {
    sub: String(user.id),
    email: user.email,
    role: user.role,
    username: user.username ?? null,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    appearance: user.appearance,
  };
}

export function isAdmin(session: Session | null): boolean {
  return session?.role === "admin";
}

/** The mirrored row for an account, for rendering a name beside their content. */
export function getUserById(id: number): UserRow | undefined {
  return getOne<UserRow>(
    qb.selectFrom("users").selectAll().where("id", "=", id)
  );
}

export function getUserByEmail(email: string): UserRow | undefined {
  return getOne<UserRow>(
    qb.selectFrom("users").selectAll().where("email", "=", email.toLowerCase())
  );
}

/**
 * A cookie is attached by the browser on its own, and `SameSite=lax` does not
 * separate this host from any other on the parent domain — every page on it is
 * the same site. So a state-changing request has to prove it came from a page
 * served by THIS host. Reads skip the check.
 *
 * A request with no Origin at all is a non-browser caller (curl, a script);
 * those authenticate with the admin token instead and never reach here with a
 * cookie, so a missing Origin fails closed.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * The credential the background jobs present when they loop back over HTTP.
 * Unset means closed, never "no gate configured, let it through" — this app
 * answers on a public hostname.
 */
export function hasCronSecret(request: Request): boolean {
  const expected = process.env.IMPORT_CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("x-import-secret") === expected;
}

/** The absolute URL of this app, for links that leave it and come back. */
export async function selfUrl(): Promise<string> {
  const configured = process.env.APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("host");
  return host ? `https://${host}` : "";
}
