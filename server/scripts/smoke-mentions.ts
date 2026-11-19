/**
 * Smoke test for creator mentions and hashtags (Grabbit 3.0.3).
 *
 * Runs against a RUNNING server over HTTP. Point it at a copy of the database,
 * never at production: it rewrites the captions of one general post and one
 * 18+ post for the run (and restores both), and it leaves the creators the
 * mentions made (origin 'mention', soft-deleted at the end).
 *
 *   BASE=http://localhost:3901 SMOKE_USER=... SMOKE_PASS=... ADULT_POST_ID=<18+ post> \
 *     ADULT_CREATOR=<handle of an 18+ creator> SMOKE_PIN=<the user's 18+ PIN> node --import tsx server/scripts/smoke-mentions.ts
 *
 * The 18+ part edits ADULT_POST_ID, which needs the 18+ unlock: SMOKE_PIN.
 */
const BASE = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.SMOKE_USER ?? '';
const PASS = process.env.SMOKE_PASS ?? '';
const ADULT_POST_ID = Number(process.env.ADULT_POST_ID) || 0;
const ADULT_CREATOR = (process.env.ADULT_CREATOR ?? '').toLowerCase();
const PIN = process.env.SMOKE_PIN ?? '';

// name -> value; the session and the 18+ unlock are separate cookies.
const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

type Scope = 'general' | 'unknown' | null;

async function call(method: string, path: string, scope: Scope, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { Origin: BASE, Cookie: cookieHeader() };
  if (scope) headers['X-Egram-Audience'] = scope;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  for (const set of r.headers.getSetCookie()) {
    const [pair] = set.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json };
}
const get = (path: string, scope: Scope = null) => call('GET', path, scope);
const handles = (post: any): string[] => (post?.mentions ?? []).map((m: any) => m.handle);
const ids = (list: any): number[] => (list?.items ?? []).map((x: any) => x.id ?? x.post_id);

async function main(): Promise<void> {
  if (!USER || !PASS) throw new Error('Set SMOKE_USER and SMOKE_PASS');
  const login = await call('POST', '/api/auth/login', null, { username: USER, password: PASS });
  check('login', login.status === 200 && jar.has('eg_session'), `HTTP ${login.status}`);

  const tag = Date.now().toString(36);
  const fresh = `smk_new_${tag}`;
  const fresh2 = `smk.two_${tag}`;
  const underscored = `_smk_under_${tag}`;
  const adultOnly = `smk_adult_${tag}`;

  // A general post and two other general creators that own posts (one to mention, one to receive the edit).
  const feed = await get('/api/feed', 'general');
  const post = (feed.json?.items ?? []).find((p: any) => p.author?.type === 'creator');
  check('a general post to edit', !!post);
  const author = post.author.handle as string;
  const other = (feed.json.items as any[]).find((p) => p.author?.type === 'creator' && p.author.handle !== author)?.author.handle as string;
  check('another general creator to mention', !!other);
  const original = post.caption as string;

  // --- Several mentions and hashtags in one caption, set by an edit ----------------------
  const caption = `Model: @${fresh} with @${other} and @${author}. Also @${fresh2}, @${underscored} #smoketag${tag} #fotografía #Ålesund`;
  const edit = await call('PATCH', `/api/posts/${post.id}`, null, { caption });
  check('edit the caption', edit.status === 200, `HTTP ${edit.status} ${JSON.stringify(edit.json)?.slice(0, 200)}`);
  const g = await get(`/api/posts/${post.id}`, 'general');
  const gh = handles(g.json);
  check('general: the new @names are links', gh.includes(fresh) && gh.includes(fresh2), gh.join(','));
  check('general: an existing creator is linked', gh.includes(other.toLowerCase()), gh.join(','));
  check('the post never mentions its own creator', !gh.includes(author.toLowerCase()));
  const under = (g.json.mentions as any[]).find((m) => m.name === underscored);
  check('an @_name gets a u- handle and keeps the written name', !!under && under.handle === `u-${underscored.replace(/^_+/, '')}`, JSON.stringify(under));
  check('the caption is stored as written', g.json.caption === caption);

  // --- The new creator: unclassified, not 18+, not followed, no poller ----------------------
  const c = await get(`/api/creators/${fresh}`);
  check('a creator was made for the new @name', c.status === 200 && c.json.origin === 'mention', `HTTP ${c.status}`);
  check('it is unclassified, not 18+', c.json?.audience === 'unknown' && c.json?.adult === false, JSON.stringify(c.json?.audience));
  check('nobody follows it and no poller runs', c.json?.following === false && c.json?.follower_count === 0 && !c.json?.ig_autopoll && !c.json?.tiktok_autopoll);
  const lim = await get(`/api/creators/${fresh}`, 'general');
  check('general: it opens as a limited profile', lim.status === 200 && lim.json.limited === true && lim.json.bio === '' && lim.json.has_avatar === false, `HTTP ${lim.status}`);
  const men = await get(`/api/creators/${fresh}/mentioned`, 'general');
  check('general: "Mentioned in" lists the post', ids(men.json).includes(post.id));
  const pub = await get(`/api/creators/${fresh}/posts`, 'general');
  check('general: it has no published posts', (pub.json?.items ?? []).length === 0);
  const otherMen = await get(`/api/creators/${other}/mentioned`, 'general');
  check('the existing creator lists the post too', ids(otherMen.json).includes(post.id));
  const ownMen = await get(`/api/creators/${author}/mentioned`, 'general');
  check('the author does not list its own post as a mention', !ids(ownMen.json).includes(post.id));
  // The Grabbit gateway treats a creator the identity lookup does not answer for
  // as 18+, so a limited profile and its mention links need an answer there.
  const idn = await get(`/api/creator-identities?h=${fresh}&h=${other}`, 'general');
  check('general: identities answer for the limited profile', idn.status === 200 && Array.isArray(idn.json?.items?.[fresh]) && Array.isArray(idn.json?.items?.[other.toLowerCase()]), JSON.stringify(idn.json));
  const uHandle = `u-${underscored.replace(/^_+/, '')}`;
  const idu = await get(`/api/creator-identities?h=${uHandle}`, 'general');
  check('general: a u- handle lists only the @name as written', JSON.stringify(idu.json?.items?.[uHandle]) === JSON.stringify([underscored.toLowerCase()]), JSON.stringify(idu.json));

  // --- Lists stay clean ----------------------------------------------------------------------
  const listAll = await get('/api/creators');
  check('the creator list leaves out empty mention creators', !(listAll.json?.items ?? []).some((x: any) => x.handle === fresh));
  const listQ = await get(`/api/creators?q=${fresh}`);
  check('a search finds it', (listQ.json?.items ?? []).some((x: any) => x.handle === fresh));
  const listGen = await get(`/api/creators?q=${fresh}`, 'general');
  check('the general creator list never shows it', !(listGen.json?.items ?? []).some((x: any) => x.handle === fresh));

  // --- Hashtags: international characters, one row per tag ----------------------------------
  for (const t of [`smoketag${tag}`, 'fotografía', 'ålesund']) {
    const h = await get(`/api/hashtags/${encodeURIComponent(t)}`, 'general');
    check(`#${t} lists the post`, ids(h.json).includes(post.id), `HTTP ${h.status}`);
  }

  // --- Duplicates: the same names again, other spelling -------------------------------------
  const again = await call('PATCH', `/api/posts/${post.id}`, null, { caption: `${caption} @${fresh.toUpperCase()} #SMOKETAG${tag}` });
  check('edit again with the same names', again.status === 200);
  const g2 = await get(`/api/posts/${post.id}`, 'general');
  check('no duplicate mention rows', handles(g2.json).filter((h) => h === fresh).length === 1, handles(g2.json).join(','));
  const dupe = await get(`/api/creators?q=smk_new_${tag}`);
  check('no duplicate creator', (dupe.json?.items ?? []).filter((x: any) => x.handle.startsWith(`smk_new_${tag}`)).length === 1);

  // --- Removing a mention removes the link, not the creator ----------------------------------
  const less = await call('PATCH', `/api/posts/${post.id}`, null, { caption: `Model: @${other}` });
  check('edit drops the new names', less.status === 200);
  const g3 = await get(`/api/posts/${post.id}`, 'general');
  check('the dropped names are no longer links', !handles(g3.json).includes(fresh) && handles(g3.json).includes(other.toLowerCase()), handles(g3.json).join(','));
  const after = await get(`/api/creators/${fresh}/mentioned`);
  check('"Mentioned in" no longer lists it', !ids(after.json).includes(post.id));
  check('the creator itself stays', (await get(`/api/creators/${fresh}`)).status === 200);
  const gone = await get(`/api/creators/${fresh}`, 'general');
  check('general: with no general mention left it is not reachable', gone.status === 404, `HTTP ${gone.status}`);

  // --- 18+ never shows in general through a mention ------------------------------------------
  if (ADULT_CREATOR) {
    await call('PATCH', `/api/posts/${post.id}`, null, { caption: `With @${ADULT_CREATOR}` });
    const ga = await get(`/api/posts/${post.id}`, 'general');
    check('general: an 18+ creator is never a link', !handles(ga.json).includes(ADULT_CREATOR), handles(ga.json).join(','));
    const pa = await get(`/api/creators/${ADULT_CREATOR}`, 'general');
    check('general: the 18+ creator does not open', pa.status === 404, `HTTP ${pa.status}`);
    const ma = await get(`/api/creators/${ADULT_CREATOR}/mentioned`, 'general');
    check('general: nor its "Mentioned in"', ma.status === 404, `HTTP ${ma.status}`);
  } else console.log('skip ADULT_CREATOR not set');
  if (ADULT_POST_ID && !PIN) console.log('skip ADULT_POST_ID needs SMOKE_PIN (18+ unlock)');
  if (ADULT_POST_ID && PIN) {
    const un = await call('POST', '/api/adult/unlock', null, { pin: PIN });
    check('18+ unlock for the 18+ part', un.status === 200, `HTTP ${un.status}`);
    const ap = await get(`/api/posts/${ADULT_POST_ID}`);
    const before = ap.json?.caption ?? '';
    const e = await call('PATCH', `/api/posts/${ADULT_POST_ID}`, null, { caption: `${before} @${adultOnly} #smokeadult${tag}` });
    check('edit the 18+ post', e.status === 200, `HTTP ${e.status}`);
    const ca = await get(`/api/creators/${adultOnly}`, 'general');
    check('general: a creator mentioned only in 18+ does not open', ca.status === 404, `HTTP ${ca.status}`);
    const ia = await get(`/api/creator-identities?h=${adultOnly}`, 'general');
    check('general: identities do not answer for it', ia.status === 200 && !(adultOnly in (ia.json?.items ?? {})), JSON.stringify(ia.json));
    // Review: a creator known only from an 18+ caption does not exist there either.
    const cu = await get(`/api/creators/${adultOnly}`, 'unknown');
    check('review: a creator mentioned only in 18+ does not open', cu.status === 404, `HTTP ${cu.status}`);
    const mu = await get(`/api/creators/${adultOnly}/mentioned`, 'unknown');
    check('review: nor its "Mentioned in"', mu.status === 404, `HTTP ${mu.status}`);
    const iu = await get(`/api/creator-identities?h=${adultOnly}`, 'unknown');
    check('review: identities do not answer for it', iu.status === 200 && !(adultOnly in (iu.json?.items ?? {})), JSON.stringify(iu.json));
    const su = await get(`/api/search?q=${adultOnly}`, 'unknown');
    check('review: search does not offer it', su.status === 200 && !(su.json?.creators ?? []).some((x: any) => x.handle === adultOnly), JSON.stringify(su.json?.creators));
    const au = await get(`/api/mentions?q=${adultOnly}`, 'unknown');
    check('review: @-suggestions do not offer it', au.status === 200 && !(au.json?.items ?? []).some((x: any) => x.handle === adultOnly));
    const lu = await get(`/api/creators?q=${adultOnly}`, 'unknown');
    check('review: the creator list search does not find it', lu.status === 200 && !(lu.json?.items ?? []).some((x: any) => x.handle === adultOnly));
    // Naming it as an upload destination in Review answers like a name nobody has.
    const upload = async (creator: string) => {
      const form = new FormData();
      form.set('creator', creator);
      form.set('caption', 'smoke destination probe');
      form.set('files', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'probe.jpg');
      const r = await fetch(`${BASE}/api/posts`, { method: 'POST', headers: { Origin: BASE, Cookie: cookieHeader(), 'X-Egram-Audience': 'unknown' }, body: form });
      const json: any = await r.json().catch(() => null);
      // A post made here would mean the check failed; do not leave it behind.
      if (json?.id) await call('DELETE', `/api/posts/${json.id}`, null);
      return { status: r.status, error: String(json?.error ?? '').replace(creator, '<name>') };
    };
    const dh = await upload(adultOnly);
    const dn = await upload(`nosuch${tag}`);
    check('review: as upload destination it answers like a missing name', dh.status === 400 && dh.status === dn.status && dh.error === dn.error, `${dh.status} ${dh.error} / ${dn.status} ${dn.error}`);
    const cun = await get(`/api/creators/${adultOnly}`);
    check('unscoped: the creator exists', cun.status === 200 && cun.json?.origin === 'mention', `HTTP ${cun.status}`);
    const ht = await get(`/api/hashtags/smokeadult${tag}`, 'general');
    check('general: the 18+ post is not under its hashtag', !ids(ht.json).includes(ADULT_POST_ID));
    const s = await get(`/api/search?q=${adultOnly}`, 'general');
    check('general: search does not find the 18+ post', !JSON.stringify(s.json ?? {}).includes(`"id":${ADULT_POST_ID},`));
    const back = await call('PATCH', `/api/posts/${ADULT_POST_ID}`, null, { caption: before });
    check('restore the 18+ caption', back.status === 200, `HTTP ${back.status}`);
    await call('POST', '/api/adult/lock', null);
  } else if (!ADULT_POST_ID) console.log('skip ADULT_POST_ID not set');

  // --- Restore -------------------------------------------------------------------------------
  const r = await call('PATCH', `/api/posts/${post.id}`, null, { caption: original });
  check('restore the general caption', r.status === 200);
  for (const h of [fresh, fresh2, `u-${underscored.replace(/^_+/, '')}`, adultOnly]) await call('DELETE', `/api/creators/${h}`, null);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
