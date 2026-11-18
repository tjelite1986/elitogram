/**
 * Smoke test for the fixes after the Grabbit 3.0 phase 2 final review.
 *
 * Runs against a RUNNING server over HTTP, signed in as an admin. Point it at a
 * copy of the database, never at production. It creates its own creators (one
 * classified general, one 18+), a member account and a few posts with generated
 * pictures, and removes them at the end: posts and creators are deleted (soft),
 * the member is disabled.
 *
 *   BASE=http://localhost:3932 SMOKE_USER=... SMOKE_PASS=... node --import tsx server/scripts/smoke-final.ts
 */
import sharp from 'sharp';

const BASE = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.SMOKE_USER ?? '';
const PASS = process.env.SMOKE_PASS ?? '';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

type Scope = 'general' | 'unknown' | null;
type Answer = { status: number; json: any; headers: Headers };

class Client {
  cookie = '';
  async call(method: string, path: string, scope: Scope, body?: unknown): Promise<Answer> {
    const headers: Record<string, string> = { Origin: BASE, Cookie: this.cookie };
    if (scope) headers['X-Egram-Audience'] = scope;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set && /^eg_session=/.test(set)) this.cookie = set.split(';')[0];
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json, headers: r.headers };
  }
  get(path: string, scope: Scope = null): Promise<Answer> {
    return this.call('GET', path, scope);
  }
  async login(username: string, password: string): Promise<boolean> {
    const r = await this.call('POST', '/api/auth/login', null, { username, password });
    return r.status === 200 && !!this.cookie;
  }
}

// A small JPEG of a random colour, so its bytes are new to the library.
async function picture(): Promise<Blob> {
  const rnd = () => Math.floor(Math.random() * 256);
  const buf = await sharp({ create: { width: 64 + Math.floor(Math.random() * 64), height: 64, channels: 3, background: { r: rnd(), g: rnd(), b: rnd() } } })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

async function upload(c: Client, scope: Scope, creator: string, count: number): Promise<Answer> {
  const fd = new FormData();
  fd.append('caption', 'smoke final');
  if (creator) fd.append('creator', creator);
  for (let i = 0; i < count; i++) fd.append('files', await picture(), `smoke-${i}.jpg`);
  return c.call('POST', '/api/posts', scope, fd);
}

async function main(): Promise<void> {
  if (!USER || !PASS) throw new Error('Set SMOKE_USER and SMOKE_PASS');
  const admin = new Client();
  check('admin login', await admin.login(USER, PASS));
  const tag = Date.now().toString(36);
  const G = `smokefin-g-${tag}`;
  const GIG = `smokefin-ig-${tag}`;
  const X = `smokefin-x-${tag}`;
  const NONE = `smokefin-none-${tag}`;
  const memberName = `smokefin-m-${tag}`;
  const memberPass = `pass-${tag}-${Math.random().toString(36).slice(2)}`;
  const posts: number[] = [];
  let memberId = 0;
  let member2Id = 0;
  let twinCreated = false;
  const member = new Client();
  try {
    check('create creator G', (await admin.call('POST', '/api/creators', null, { handle: G })).status === 201);
    check('G classified general with an Instagram name', (await admin.call('PATCH', `/api/creators/${G}`, null, { audience: 'general', ig_handle: GIG })).status === 200);
    check('create 18+ creator X', (await admin.call('POST', '/api/creators', null, { handle: X, adult: true })).status === 201);
    const mk = await admin.call('POST', '/api/admin/users', null, { username: memberName, password: memberPass });
    memberId = mk.json?.id ?? 0;
    check('create member', mk.status === 201 && memberId > 0, JSON.stringify(mk.json));
    check('member login', await member.login(memberName, memberPass));
    check('admin follows G', (await admin.call('POST', `/api/creators/${G}/follow`, null)).status < 300);

    // --- Upload under a general creator by a member: held for review ---------
    const up = await upload(member, 'unknown', G, 2);
    const pid = up.json?.id;
    if (Number.isInteger(pid)) posts.push(pid);
    check('member upload under G is accepted', up.status === 201 && Number.isInteger(pid), JSON.stringify(up.json));
    check('a scoped upload answer does not state the audience', up.json && !('audience' in up.json), JSON.stringify(up.json));
    check('held post is not general', (await member.get(`/api/posts/${pid}`, 'general')).status === 404);
    const inReview = await member.get(`/api/posts/${pid}`, 'unknown');
    check('held post is in the unknown scope', inReview.status === 200 && inReview.json?.audience === 'unknown');
    const media: number[] = (inReview.json?.media ?? []).map((m: any) => m.id);
    check('held post has two items', media.length === 2);

    // --- Identity lookup answers for the creator of a held post ----------------
    const idsU = await member.get(`/api/creator-identities?h=${G}&a=${memberName}&h=${X}&a=${X}&h=${NONE}&a=${NONE}`, 'unknown');
    check('unknown scope: identities of G (creator of a held post) are listed', Array.isArray(idsU.json?.items?.[G]) && idsU.json.items[G].includes(GIG), JSON.stringify(idsU.json));
    check('unknown scope: the member is listed as an account', Array.isArray(idsU.json?.accounts) && idsU.json.accounts.includes(memberName));
    check('unknown scope: 18+ X is not answered at all', !(X in (idsU.json?.items ?? {})) && !(idsU.json?.accounts ?? []).includes(X));
    check('unknown scope: an unknown name is not answered', !(NONE in (idsU.json?.items ?? {})) && !(idsU.json?.accounts ?? []).includes(NONE));
    const idsG = await member.get(`/api/creator-identities?h=${G}`, 'general');
    check('general scope: identities of G are listed', Array.isArray(idsG.json?.items?.[G]));
    // Creators and accounts are separate namespaces: asked as a creator, an
    // account is not answered; an 18+ creator sharing the account's name does
    // not hide the account.
    const asCreator = await member.get(`/api/creator-identities?h=${memberName}`, 'unknown');
    check('an account asked for as a creator is not answered', !(memberName in (asCreator.json?.items ?? {})) && !(asCreator.json?.accounts ?? []).includes(memberName), JSON.stringify(asCreator.json));
    const twin = await admin.call('POST', '/api/creators', null, { handle: memberName, adult: true });
    if (twin.status === 201) {
      twinCreated = true;
      const both = await member.get(`/api/creator-identities?h=${memberName}&a=${memberName}`, 'general');
      check('an 18+ creator sharing the name: the account is still listed', (both.json?.accounts ?? []).includes(memberName), JSON.stringify(both.json));
      check('an 18+ creator sharing the name: the creator is not answered', !(memberName in (both.json?.items ?? {})));
    } else check('a creator may share an account name (or is refused cleanly)', twin.status >= 400 && twin.status < 500, `${twin.status}`);

    // --- Notifications: a scoped "read" leaves out-of-scope ones unread ----------
    const unreadAll = (await admin.get('/api/notifications')).json?.items?.filter((n: any) => n.post_id === pid && !n.read_at) ?? [];
    check('admin got a notification about the held post', unreadAll.length > 0);
    check('general-scope read answers', (await admin.call('POST', '/api/notifications/read', 'general')).status === 200);
    const stillUnread = (await admin.get('/api/notifications')).json?.items?.filter((n: any) => n.post_id === pid && !n.read_at) ?? [];
    check('the held post notification stays unread after a general-scope read', stillUnread.length === unreadAll.length && unreadAll.length > 0);
    const target = stillUnread[0]?.id;
    check('a general-scope read with its id leaves it unread', (await admin.call('POST', '/api/notifications/read', 'general', { ids: [target] })).status === 200
      && !!(await admin.get('/api/notifications')).json?.items?.find((n: any) => n.id === target && !n.read_at));
    const otherUnread = ((await admin.get('/api/notifications')).json?.items ?? []).filter((n: any) => !n.read_at && n.id !== target).length;
    check('a read with ids answers', (await admin.call('POST', '/api/notifications/read', 'unknown', { ids: [target] })).status === 200);
    const after = (await admin.get('/api/notifications')).json?.items ?? [];
    check('a read with ids marks that one', !!after.find((n: any) => n.id === target && n.read_at));
    check('a read with ids leaves the others unread', after.filter((n: any) => !n.read_at && n.id !== target).length === otherUnread, `${otherUnread}`);
    check('ids that are not a list answer 400', (await admin.call('POST', '/api/notifications/read', 'unknown', { ids: 'all' })).status === 400);

    // --- Removing an item from a held post: the removed item is not general ----
    const rm = await member.call('PATCH', `/api/posts/${pid}`, 'unknown', { removeMedia: [media[1]] });
    check('member removes one item', rm.status === 200, JSON.stringify(rm.json));
    check('removed item is not served in the general scope', (await member.get(`/m/${media[1]}`, 'general')).status === 404);
    check('removed item thumbnail is not served in the general scope', (await member.get(`/m/${media[1]}/t`, 'general')).status === 404);
    check('kept item is not served in the general scope', (await member.get(`/m/${media[0]}`, 'general')).status === 404);

    // --- An 18+ creator is unknown to a scoped or locked caller ----------------
    const toX = await upload(member, 'general', X, 1);
    const toNone = await upload(member, 'general', NONE, 1);
    if (Number.isInteger(toX.json?.id)) posts.push(toX.json.id);
    if (Number.isInteger(toNone.json?.id)) posts.push(toNone.json.id);
    check('scoped upload under 18+ X answers 400', toX.status === 400, `${toX.status} ${JSON.stringify(toX.json)}`);
    check('same answer shape as an unknown name', toX.status === toNone.status && String(toX.json?.error).replace(X, '?') === String(toNone.json?.error).replace(NONE, '?'));
    const toXLocked = await upload(member, null, X, 1);
    if (Number.isInteger(toXLocked.json?.id)) posts.push(toXLocked.json.id);
    check('unscoped upload by a member without the 18+ unlock under X answers 400', toXLocked.status === 400, `${toXLocked.status}`);
    const moveX = await member.call('PATCH', `/api/posts/${pid}`, 'unknown', { author: { creator: X } });
    check('moving a post to 18+ X answers like an unknown creator', moveX.status === 400 && /Unknown creator/.test(String(moveX.json?.error)), `${moveX.status} ${JSON.stringify(moveX.json)}`);
    const own = await upload(member, null, '', 1);
    if (Number.isInteger(own.json?.id)) posts.push(own.json.id);
    check('unscoped upload answer still states the audience', own.status === 201 && typeof own.json?.audience === 'string', JSON.stringify(own.json));
    // A refused move under a general creator writes nothing else of the request.
    const ownId = own.json?.id;
    const toG = await member.call('PATCH', `/api/posts/${ownId}`, null, { caption: 'should not stick', author: { creator: G } });
    check('member moving a post under general G answers 403', toG.status === 403, `${toG.status}`);
    check('the refused move left the caption alone', (await member.get(`/api/posts/${ownId}`)).json?.caption === 'smoke final');

    // --- A deleted post no longer opens its creator's identities to others ----
    const other = new Client();
    const mk2 = await admin.call('POST', '/api/admin/users', null, { username: `${memberName}-2`, password: memberPass });
    member2Id = mk2.json?.id ?? 0;
    check('second member logs in', mk2.status === 201 && (await other.login(`${memberName}-2`, memberPass)));
    check('before the delete, another member sees G identities in the unknown scope', Array.isArray((await other.get(`/api/creator-identities?h=${G}`, 'unknown')).json?.items?.[G]));
    check('admin deletes the held post', (await admin.call('DELETE', `/api/posts/${pid}`, null)).status < 300);
    check('after the delete, another member gets nothing for G', !(G in ((await other.get(`/api/creator-identities?h=${G}`, 'unknown')).json?.items ?? {})));
    check('after the delete, its uploader still gets G', Array.isArray((await member.get(`/api/creator-identities?h=${G}`, 'unknown')).json?.items?.[G]));
  } finally {
    for (const id of posts) await admin.call('DELETE', `/api/posts/${id}`, null).catch(() => undefined);
    await admin.call('DELETE', `/api/creators/${G}/follow`, null).catch(() => undefined);
    for (const h of [G, X, ...(twinCreated ? [memberName] : [])]) await admin.call('DELETE', `/api/creators/${h}`, null).catch(() => undefined);
    for (const id of [memberId, member2Id]) if (id) await admin.call('PATCH', `/api/admin/users/${id}`, null, { disabled: true }).catch(() => undefined);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
