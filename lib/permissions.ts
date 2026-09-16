import { db } from "./db";

// Capabilities an admin can grant individual users. Admins implicitly hold every
// permission (no rows needed). Keep these keys in sync with the settings panels
// that gate on them.
export const PERMISSIONS = [
  { key: "library_settings", label: "Library tools" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export const PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

function isKey(k: string): k is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(k);
}

export function getUserPermissions(userId: number): PermissionKey[] {
  return (
    db
      .prepare("SELECT permission FROM user_permissions WHERE user_id = ?")
      .all(userId) as { permission: string }[]
  )
    .map((r) => r.permission)
    .filter(isKey);
}

// True if the session may enter a permission-gated area: admins always; everyone
// else only when granted that exact key. Pass the getSession() result.
export function hasPermission(
  session: { sub?: string | number; role?: string } | null | undefined,
  key: PermissionKey
): boolean {
  if (!session) return false;
  if (session.role === "admin") return true;
  const userId = Number(session.sub);
  if (!Number.isInteger(userId)) return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?"
      )
      .get(userId, key)
  );
}

// Replace a user's granted permissions with the given valid set (admin action).
export function setUserPermissions(userId: number, keys: string[]): void {
  const valid = Array.from(new Set(keys.filter(isKey)));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_permissions WHERE user_id = ?").run(userId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO user_permissions (user_id, permission) VALUES (?, ?)"
    );
    for (const k of valid) ins.run(userId, k);
  });
  tx();
}
