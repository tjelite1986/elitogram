import type { Request } from 'express';

/**
 * Audience scopes (Grabbit 3.0 phase 2).
 *
 * A caller may narrow what a request can see by sending `X-Egram-Audience`:
 *   general  only posts classified general by hand (the post itself, or its
 *            creator), never 18+
 *   unknown  only posts nobody has classified yet, never 18+
 * Without the header the app behaves as before. A scope can only narrow: a
 * scoped request never sees 18+ material, whatever its unlock cookie says, so
 * the header is safe to accept from anyone. Grabbit's gateway sends it on
 * every request it forwards.
 *
 * The effective audience of a post: 18+ when the post or its creator carries
 * the adult flag; general when the post or its creator was classified general;
 * otherwise unknown. Unknown is never treated as general.
 */
export type Scope = 'general' | 'unknown';
export const AUDIENCE_VALUES = ['general', 'unknown'] as const;

export function scopeOf(req: Request): Scope | null {
  const v = String(req.get('x-egram-audience') ?? '').trim().toLowerCase();
  if (!v) return null;
  // Anything else still narrows: an unknown value sees nothing rather than everything.
  return v === 'general' || v === 'unknown' ? v : 'general';
}

export const isScoped = (req: Request): boolean => scopeOf(req) !== null;

/** SQL condition on posts `p` LEFT JOINed with creators `c`. */
export function scopeSql(scope: Scope | null): string {
  if (scope === 'general') return "(p.audience = 'general' OR COALESCE(c.audience, 'unknown') = 'general')";
  if (scope === 'unknown') return "(p.audience <> 'general' AND COALESCE(c.audience, 'unknown') <> 'general')";
  return '1=1';
}

/**
 * SQL condition: may the creator row aliased `alias` be shown in this scope?
 * General: the creator was classified general, or owns at least one post
 * classified general (such a profile shows only those posts). Unknown: the
 * creator itself is not classified general. 18+ is filtered separately.
 */
export function creatorScopeSql(scope: Scope | null, alias = 'c'): string {
  if (scope === 'general') {
    return `(${alias}.audience = 'general' OR EXISTS (SELECT 1 FROM posts px WHERE px.creator_id = ${alias}.id AND px.deleted = 0 AND px.adult = 0 AND px.audience = 'general'))`;
  }
  if (scope === 'unknown') return `(${alias}.audience <> 'general')`;
  return '1=1';
}

/** Values a classify request may set. 'adult' sets the 18+ flag; nothing ever clears it here. */
export const CLASSIFY_VALUES = ['general', 'unknown', 'adult'] as const;
export type ClassifyValue = (typeof CLASSIFY_VALUES)[number];

export function parseClassify(v: unknown): ClassifyValue | null {
  return typeof v === 'string' && (CLASSIFY_VALUES as readonly string[]).includes(v) ? (v as ClassifyValue) : null;
}

export function effectiveAudience(row: { adult?: unknown; audience?: unknown; c_adult?: unknown; c_audience?: unknown }): 'adult' | 'general' | 'unknown' {
  if (row.adult || row.c_adult) return 'adult';
  if (row.audience === 'general' || row.c_audience === 'general') return 'general';
  return 'unknown';
}

export function scopeAllows(scope: Scope | null, audience: 'adult' | 'general' | 'unknown'): boolean {
  if (!scope) return true;
  if (audience === 'adult') return false;
  return audience === scope;
}
