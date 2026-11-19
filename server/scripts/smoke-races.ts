/**
 * Smoke test for post edits that race a classification while files move.
 *
 * Needs a RUNNING server started with TEST_MOVE_DELAY_MS (for example 1500):
 * every reassignment then pauses after moving its files, and this script
 * changes the post, its creator or the destination during that pause. Point it
 * at a copy of the database, never at production. Signed in as an admin. It
 * creates its own creators, a member and a few posts, and removes them at the
 * end (posts and creators soft-deleted, the member disabled).
 *
 *   BASE=http://localhost:3932 SMOKE_USER=... SMOKE_PASS=... node --import tsx server/scripts/smoke-races.ts
 */
import sharp from 'sharp';

const BASE = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.SMOKE_USER ?? '';
const PASS = process.env.SMOKE_PASS ?? '';
// Must be well inside the server's TEST_MOVE_DELAY_MS.
const DURING_MS = Number(process.env.DURING_MS ?? '400');

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

type Scope = 'general' | 'unknown' | null;
type Answer = { status: number; json: any };

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
    return { status: r.status, json };
  }
  get(path: string, scope: Scope = null): Promise<Answer> {
    return this.call('GET', path, scope);
  }
  async login(username: string, password: string): Promise<boolean> {
    const r = await this.call('POST', '/api/auth/login', null, { username, password });
    return r.status === 200 && !!this.cookie;
  }
}

async function picture(): Promise<Blob> {
  const rnd = () => Math.floor(Math.random() * 256);
  const buf = await sharp({ create: { width: 64 + Math.floor(Math.random() * 64), height: 64, channels: 3, background: { r: rnd(), g: rnd(), b: rnd() } } })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

async function upload(c: Client, creator: string, count: number): Promise<number> {
  const fd = new FormData();
  fd.append('caption', 'smoke races');
  if (creator) fd.append('creator', creator);
  for (let i = 0; i < count; i++) fd.append('files', await picture(), `race-${i}.jpg`);
  const r = await c.call('POST', '/api/posts', null, fd);
  if (r.status !== 201 || !Number.isInteger(r.json?.id)) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every media item of the post answers 200 for this client (its file is where its row says). */
async function mediaServed(c: Client, postId: number): Promise<boolean> {
  const p = await c.get(`/api/posts/${postId}`);
  const media: number[] = (p.json?.media ?? []).map((m: any) => m.id);
  if (!media.length) return false;
  for (const m of media) if ((await c.get(`/m/${m}`)).status !== 200) return false;
  return true;
}

async function main(): Promise<void> {
  if (!USER || !PASS) throw new Error('Set SMOKE_USER and SMOKE_PASS');
  const admin = new Client();
  const admin2 = new Client();
  check('admin login', await admin.login(USER, PASS));
  check('second admin session', await admin2.login(USER, PASS));
  const tag = Date.now().toString(36);
  const A = `smokerace-a-${tag}`;
  const B = `smokerace-b-${tag}`;
  const C = `smokerace-c-${tag}`;
  const memberName = `smokerace-m-${tag}`;
  const memberPass = `pass-${tag}-${Math.random().toString(36).slice(2)}`;
  const posts: number[] = [];
  let memberId = 0;
  const member = new Client();
  try {
    for (const h of [A, B, C]) check(`create creator ${h}`, (await admin.call('POST', '/api/creators', null, { handle: h })).status === 201);
    const mk = await admin.call('POST', '/api/admin/users', null, { username: memberName, password: memberPass });
    memberId = mk.json?.id ?? 0;
    check('create member', mk.status === 201 && memberId > 0);
    check('member login', await member.login(memberName, memberPass));

    // --- Control: with nothing in between, a reassignment succeeds ---------------
    const p0 = await upload(member, '', 2);
    posts.push(p0);
    const ok0 = await member.call('PATCH', `/api/posts/${p0}`, 'unknown', { author: { creator: A } });
    check('control: member moves own post to unclassified A', ok0.status === 200, `${ok0.status} ${JSON.stringify(ok0.json)}`);
    check('control: post is under A', (await member.get(`/api/posts/${p0}`)).json?.author?.handle === A);
    check('control: its media are served', await mediaServed(member, p0));

    // --- A moderator's stale adult:false cannot clear a concurrent 18+ mark ------
    const p1 = await upload(admin, A, 1);
    posts.push(p1);
    const stale1 = admin.call('PATCH', `/api/posts/${p1}`, null, { author: { creator: B }, adult: false, caption: 'stale' });
    await wait(DURING_MS);
    const mark = await admin2.call('PATCH', `/api/posts/${p1}`, null, { adult: true });
    const r1 = await stale1;
    check('concurrent 18+ mark lands', mark.status === 200, `${mark.status} ${JSON.stringify(mark.json)}`);
    check('the stale moderator edit answers 409', r1.status === 409, `${r1.status} ${JSON.stringify(r1.json)}`);
    const after1 = (await admin.get(`/api/posts/${p1}`)).json;
    check('the post stays 18+', after1?.adult === true, JSON.stringify(after1?.adult));
    check('the post stays under A', after1?.author?.handle === A);
    check('the stale caption was not written', after1?.caption === 'smoke races');

    // --- The destination turns 18+ while the files move ------------------------
    const p2 = await upload(member, '', 1);
    posts.push(p2);
    const move2 = member.call('PATCH', `/api/posts/${p2}`, 'unknown', { author: { creator: C } });
    await wait(DURING_MS);
    const cAdult = await admin2.call('PATCH', `/api/creators/${C}`, null, { adult: true });
    const r2 = await move2;
    check('destination C marked 18+ meanwhile', cAdult.status === 200, `${cAdult.status}`);
    check('the move to C answers 409', r2.status === 409, `${r2.status} ${JSON.stringify(r2.json)}`);
    const after2 = (await member.get(`/api/posts/${p2}`)).json;
    check('the post stays with its member author', after2?.author?.type === 'user' && after2?.author?.handle === memberName, JSON.stringify(after2?.author));
    check('its media are served after the move back', await mediaServed(member, p2));

    // --- The destination is classified general while the files move -------------
    const p3 = await upload(member, '', 1);
    posts.push(p3);
    const move3 = member.call('PATCH', `/api/posts/${p3}`, 'unknown', { author: { creator: B } });
    await wait(DURING_MS);
    const bGeneral = await admin2.call('PATCH', `/api/creators/${B}`, null, { audience: 'general' });
    const r3 = await move3;
    check('destination B classified general meanwhile', bGeneral.status === 200, `${bGeneral.status}`);
    check('the move to B answers 409', r3.status === 409, `${r3.status}`);
    check('the post is not general', (await member.get(`/api/posts/${p3}`, 'general')).status === 404);
    check('its media are served after the move back', await mediaServed(member, p3));

    // --- Two reassignments of one post at once: one wins, files follow the row ---
    const p4 = await upload(admin, A, 2);
    posts.push(p4);
    const first = admin.call('PATCH', `/api/posts/${p4}`, null, { author: { creator: B } });
    await wait(50);
    const second = admin2.call('PATCH', `/api/posts/${p4}`, null, { author: { self: true } });
    const [f, s] = await Promise.all([first, second]);
    check('first reassignment wins', f.status === 200, `${f.status} ${JSON.stringify(f.json)}`);
    check('the second, decided on the old state, answers 409', s.status === 409, `${s.status} ${JSON.stringify(s.json)}`);
    check('the post is under B', (await admin.get(`/api/posts/${p4}`)).json?.author?.handle === B);
    check('all its media are served', await mediaServed(admin, p4));

    // --- Removing an item while the post is marked 18+ meanwhile -----------------
    const p5 = await upload(admin, A, 2);
    posts.push(p5);
    check('A classified general for the removal case', (await admin.call('PATCH', `/api/creators/${A}`, null, { audience: 'general' })).status === 200);
    const m5: number[] = ((await admin.get(`/api/posts/${p5}`)).json?.media ?? []).map((m: any) => m.id);
    const rm = admin.call('PATCH', `/api/posts/${p5}`, null, { author: { creator: C }, adult: false, removeMedia: [m5[1]] });
    await wait(DURING_MS);
    await admin2.call('PATCH', `/api/posts/${p5}`, null, { adult: true });
    const r5 = await rm;
    check('the stale removal answers 409', r5.status === 409, `${r5.status}`);
    check('both items stay on the post', ((await admin.get(`/api/posts/${p5}`)).json?.media ?? []).length === 2);
    check('the removed-to-be item is not general', (await member.get(`/m/${m5[1]}`, 'general')).status === 404);
  } finally {
    for (const id of posts) await admin.call('DELETE', `/api/posts/${id}`, null).catch(() => undefined);
    for (const h of [A, B, C]) await admin.call('DELETE', `/api/creators/${h}`, null).catch(() => undefined);
    if (memberId) await admin.call('PATCH', `/api/admin/users/${memberId}`, null, { disabled: true }).catch(() => undefined);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
