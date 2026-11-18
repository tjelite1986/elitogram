/**
 * Smoke test for the audience scopes and the social routes (Grabbit 3.0 phase 2).
 *
 * Runs against a RUNNING server over HTTP. Point it at a copy of the database,
 * never at production: it reclassifies one creator and one post for the
 * duration of the run (and restores both), creates and deletes a collection,
 * and clears the test user's viewing history.
 *
 *   BASE=http://localhost:3901 SMOKE_USER=... SMOKE_PASS=... \
 *     [ADULT_POST_ID=<id of an 18+ post>] node --import tsx server/scripts/smoke-audience.ts
 */
const BASE = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.SMOKE_USER ?? '';
const PASS = process.env.SMOKE_PASS ?? '';
const ADULT_POST_ID = Number(process.env.ADULT_POST_ID) || 0;

let cookie = '';
let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

type Scope = 'general' | 'unknown' | 'bogus' | null;

async function call(method: string, path: string, scope: Scope, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { Origin: BASE, Cookie: cookie };
  if (scope) headers['X-Egram-Audience'] = scope;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, headers: r.headers };
}

const get = (path: string, scope: Scope = null) => call('GET', path, scope);

async function main(): Promise<void> {
  if (!USER || !PASS) throw new Error('Set SMOKE_USER and SMOKE_PASS');
  const login = await call('POST', '/api/auth/login', null, { username: USER, password: PASS });
  check('login', login.status === 200 && !!cookie, `HTTP ${login.status}`);

  // Two non-adult creators with posts: A becomes general for the run, B stays unknown.
  const list = await get('/api/creators');
  const withPosts = (list.json?.items ?? []).filter((c: any) => !c.adult && c.post_count > 0 && c.audience !== 'general');
  check('two unclassified creators to work with', withPosts.length >= 2);
  const [A, B] = withPosts;
  const classify = await call('POST', '/api/creators-classify', null, { handles: [A.handle], audience: 'general' });
  check('classify A general', classify.status === 200 && classify.json.updated.includes(A.handle), JSON.stringify(classify.json));

  try {
    // Feed, explore and creators in the general scope.
    const feed = await get('/api/feed', 'general');
    const fi = feed.json?.items ?? [];
    check('general feed has items', fi.length > 0);
    check('general feed is all general', fi.every((p: any) => p.audience === 'general'));
    check("general feed includes A's posts", fi.some((p: any) => p.author?.handle === A.handle));
    const ex = await get('/api/explore', 'general');
    check('general explore is all general', (ex.json?.items ?? []).every((t: any) => t.audience === 'general'));
    const cl = await get('/api/creators', 'general');
    check('general creator list is all general', (cl.json?.items ?? []).every((c: any) => c.audience === 'general'), `${cl.json?.items?.length} creators`);
    check('B profile hidden in general scope', (await get(`/api/creators/${B.handle}`, 'general')).status === 404);
    check('B posts hidden in general scope', (await get(`/api/creators/${B.handle}/posts`, 'general')).status === 404);
    check('A profile visible in general scope', (await get(`/api/creators/${A.handle}`, 'general')).json?.audience === 'general');

    // The unknown lane.
    const uf = await get('/api/feed', 'unknown');
    check('unknown feed is all unknown', (uf.json?.items ?? []).every((p: any) => p.audience === 'unknown'));
    check("unknown feed excludes A's posts", !(uf.json?.items ?? []).some((p: any) => p.author?.handle === A.handle));
    check('A profile hidden in unknown scope', (await get(`/api/creators/${A.handle}`, 'unknown')).status === 404);
    const bogus = await get('/api/feed', 'bogus');
    check('an unrecognised scope narrows to general', (bogus.json?.items ?? []).every((p: any) => p.audience === 'general'));

    // Media: audience and creator headers, and refusals outside the scope.
    const aPosts = await get(`/api/creators/${A.handle}/posts`, 'general');
    const aTile = aPosts.json?.items?.[0];
    const bPosts = await get(`/api/creators/${B.handle}/posts`);
    const bTile = bPosts.json?.items?.[0];
    const aThumb = await get(`/m/${aTile.media_id}/t`, 'general');
    check('A media carries X-Egram-Audience: general', aThumb.headers.get('x-egram-audience') === 'general');
    check('A media carries X-Egram-Creator', aThumb.headers.get('x-egram-creator') === A.handle);
    const bThumb = await get(`/m/${bTile.media_id}/t`, 'general');
    check('B media refused in general scope', bThumb.status === 404 && !bThumb.headers.get('x-egram-audience'));
    check('B post refused in general scope', (await get(`/api/posts/${bTile.id}`, 'general')).status === 404);

    // 18+ is out of reach for any scope.
    if (ADULT_POST_ID) {
      for (const s of ['general', 'unknown'] as const) {
        check(`18+ post refused in ${s} scope`, (await get(`/api/posts/${ADULT_POST_ID}`, s)).status === 404);
      }
      const adultClassify = await call('POST', '/api/creators-classify', 'unknown', { handles: ['__nobody__'], audience: 'general' });
      check('classify of an unknown handle is skipped', adultClassify.json?.skipped?.[0]?.reason === 'not found');
    }

    // Reclassifying one post moves it between the lanes.
    const patch = await call('PATCH', `/api/posts/${bTile.id}`, 'unknown', { audience: 'general' });
    check('PATCH audience general from the unknown lane', patch.status === 200 && patch.json.out_of_scope === true, JSON.stringify(patch.json).slice(0, 120));
    check('reclassified post now visible in general scope', (await get(`/api/posts/${bTile.id}`, 'general')).json?.audience === 'general');
    check('B profile now visible through its general post', (await get(`/api/creators/${B.handle}`, 'general')).status === 200);
    const back = await call('PATCH', `/api/posts/${bTile.id}`, null, { audience: 'unknown' });
    check('post restored to unknown', back.json?.audience === 'unknown');
    check('PATCH rejects a bad audience', (await call('PATCH', `/api/posts/${bTile.id}`, null, { audience: 'nope' })).status === 400);

    // Hashtag totals never count posts outside the scope.
    const tags = await get('/api/hashtags', 'general');
    const tag = tags.json?.items?.[0];
    if (tag) {
      const t = await get(`/api/hashtags/${encodeURIComponent(tag.tag)}`, 'general');
      check('scoped hashtag total matches the scoped tag count', t.json?.total === tag.n, `${t.json?.total} vs ${tag.n}`);
    }

    // Explore facets.
    const vids = await get('/api/explore?kind=video');
    check('explore kind=video', (vids.json?.items ?? []).every((t: any) => t.has_video));
    const imgs = await get('/api/explore?kind=image');
    check('explore kind=image', (imgs.json?.items ?? []).every((t: any) => !t.has_video));
    const tall = await get('/api/explore?orient=portrait');
    check('explore orient=portrait', (tall.json?.items ?? []).every((t: any) => t.height > t.width));

    // Social routes.
    const photos = await get('/api/photos', 'general');
    check('photos are all general images', (photos.json?.items ?? []).length > 0 && photos.json.items.every((p: any) => p.audience === 'general'));
    const cats = await get('/api/categories', 'general');
    check('categories total equals image+video', cats.json?.total === cats.json?.kinds?.image + cats.json?.kinds?.video, JSON.stringify(cats.json?.kinds));

    const name = `smoke-${Date.now()}`;
    const col = await call('POST', '/api/collections', 'general', { name });
    check('create collection', col.status === 201);
    try {
      check('duplicate collection name is 409', (await call('POST', '/api/collections', 'general', { name })).status === 409);
      check('add A post', (await call('POST', `/api/collections/${col.json.id}/items`, 'general', { post_id: aTile.id })).status === 200);
      check('adding a post outside the scope is 404', (await call('POST', `/api/collections/${col.json.id}/items`, 'general', { post_id: bTile.id })).status === 404);
      const mine = (await get('/api/collections', 'general')).json?.items?.find((c: any) => c.id === col.json.id);
      check('collection count and cover', mine?.count === 1 && mine?.cover?.id === aTile.id);
      const inner = await get(`/api/collections/${col.json.id}/posts`, 'general');
      check('collection posts', inner.json?.items?.length === 1);
      const memberOf = await get(`/api/posts/${aTile.id}/collections`, 'general');
      check('post lists its collections', (memberOf.json?.items ?? []).includes(col.json.id));
      check('remove item', (await call('DELETE', `/api/collections/${col.json.id}/items/${aTile.id}`, 'general')).status === 200);
      check('rename collection', (await call('PATCH', `/api/collections/${col.json.id}`, 'general', { name: `${name}-x` })).json?.name === `${name}-x`);
    } finally {
      check('delete collection', (await call('DELETE', `/api/collections/${col.json.id}`, 'general')).status === 200);
    }

    check('favorite', (await call('POST', `/api/posts/${aTile.id}/favorite`, 'general')).json?.favorited === true);
    check('favorites list', ((await get('/api/favorites', 'general')).json?.items ?? []).some((t: any) => t.id === aTile.id));
    check('post shows favorited', (await get(`/api/posts/${aTile.id}`, 'general')).json?.favorited === true);
    check('unfavorite', (await call('DELETE', `/api/posts/${aTile.id}/favorite`, 'general')).json?.favorited === false);

    check('record a view', (await call('POST', `/api/posts/${aTile.id}/view`, 'general')).status === 200);
    check('view outside the scope is 404', (await call('POST', `/api/posts/${bTile.id}/view`, 'general')).status === 404);
    check('history lists the view', ((await get('/api/history', 'general')).json?.items ?? [])[0]?.id === aTile.id);
    check('clear history', (await call('DELETE', '/api/history', 'general')).json?.ok === true);

    const dl = await get(`/m/${aTile.media_id}?download=1`, 'general');
    check('download asks for an attachment (or the file is absent from this copy)', dl.status === 404 || /attachment/.test(dl.headers.get('content-disposition') ?? ''));
  } finally {
    const reset = await call('POST', '/api/creators-classify', null, { handles: [A.handle], audience: 'unknown' });
    check('A restored to unknown', reset.json?.updated?.includes(A.handle));
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
