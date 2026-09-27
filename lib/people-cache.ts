// Store for the built /people directory, in its own module because both sides
// need it without a cycle: lib/directory.ts (which fills and reads it) already
// imports lib/profiles.ts, whose avatar/profile writes must clear it.
const cache = new Map<string, { at: number; list: unknown }>();

export function getCachedPeople<T>(key: string, ttlMs: number): T | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at >= ttlMs) return null;
  return hit.list as T;
}

export function setCachedPeople(key: string, list: unknown): void {
  cache.set(key, { at: Date.now(), list });
}

export function invalidatePeopleDirectory(): void {
  cache.clear();
}
