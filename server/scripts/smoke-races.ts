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
 *   BASE=http://localhost:3932 SMOKE_USER=... SMOKE_PASS=... [MEDIA_UPPER=/path/to/media] node --import tsx server/scripts/smoke-races.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BASE = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.SMOKE_USER ?? '';
const PASS = process.env.SMOKE_PASS ?? '';
// Must be well inside the server's TEST_MOVE_DELAY_MS.
const DURING_MS = Number(process.env.DURING_MS ?? '400');
// Optional: the host folder where the server's media writes land (for the file-location check).
const MEDIA_UPPER = process.env.MEDIA_UPPER ?? '';

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
  const D = `smokerace-d-${tag}`;
  const E = [1, 2, 3].map((i) => `smokerace-e${i}-${tag}`);
  let modId = 0;
  const memberName = `smokerace-m-${tag}`;
  const memberPass = `pass-${tag}-${Math.random().toString(36).slice(2)}`;
  const posts: number[] = [];
  let memberId = 0;
  const member = new Client();
  try {
    for (const h of [A, B, C, D, ...E]) check(`create creator ${h}`, (await admin.call('POST', '/api/creators', null, { handle: h })).status === 201);
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
    // The admin has not unlocked 18+, so an 18+ post is simply not found for it.
    const p1 = await upload(admin, A, 1);
    posts.push(p1);
    const stale1 = admin.call('PATCH', `/api/posts/${p1}`, null, { author: { creator: B }, adult: false, caption: 'stale' });
    await wait(DURING_MS);
    const mark = await admin2.call('PATCH', `/api/posts/${p1}`, null, { adult: true });
    const r1 = await stale1;
    check('concurrent 18+ mark lands', mark.status === 200, `${mark.status} ${JSON.stringify(mark.json)}`);
    check('the stale moderator edit answers 409', r1.status === 409, `${r1.status} ${JSON.stringify(r1.json)}`);
    check('the post stays 18+ (not found while locked)', (await admin.get(`/api/posts/${p1}`)).status === 404);
    for (const sc of ['general', 'unknown'] as const) check(`the post is not in the ${sc} scope`, (await admin.get(`/api/posts/${p1}`, sc)).status === 404);

    // --- A moderator's stale audience cannot overwrite a newer classification ----
    const p1b = await upload(admin, A, 1);
    posts.push(p1b);
    const stale1b = admin.call('PATCH', `/api/posts/${p1b}`, null, { author: { creator: B }, audience: 'unknown', caption: 'stale' });
    await wait(DURING_MS);
    const cls = await admin2.call('PATCH', `/api/posts/${p1b}`, null, { audience: 'general' });
    const r1b = await stale1b;
    check('concurrent classification lands', cls.status === 200, `${cls.status}`);
    check('the stale audience edit answers 409', r1b.status === 409, `${r1b.status}`);
    const after1b = (await admin.get(`/api/posts/${p1b}`)).json;
    check('the newer classification stays', after1b?.audience === 'general', JSON.stringify(after1b?.audience));
    check('the post stays under A', after1b?.author?.handle === A);
    check('the stale caption was not written', after1b?.caption === 'smoke races');
    check('its media are served after the move back', await mediaServed(admin, p1b));

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

    // --- Removing an item while the creator is declassified meanwhile ----------
    const p5 = await upload(admin, A, 2);
    posts.push(p5);
    check('A classified general for the removal case', (await admin.call('PATCH', `/api/creators/${A}`, null, { audience: 'general' })).status === 200);
    const m5: number[] = ((await admin.get(`/api/posts/${p5}`)).json?.media ?? []).map((m: any) => m.id);
    const rm = admin.call('PATCH', `/api/posts/${p5}`, null, { author: { creator: B }, removeMedia: [m5[1]] });
    await wait(DURING_MS);
    const declass = await admin2.call('PATCH', `/api/creators/${A}`, null, { audience: 'unknown' });
    const r5 = await rm;
    check('A declassified meanwhile', declass.status === 200, `${declass.status}`);
    check('the stale removal answers 409', r5.status === 409, `${r5.status} ${JSON.stringify(r5.json)}`);
    check('both items stay on the post', ((await admin.get(`/api/posts/${p5}`)).json?.media ?? []).length === 2);
    check('the post is under A again', (await admin.get(`/api/posts/${p5}`)).json?.author?.handle === A);
    check('the item is not general', (await member.get(`/m/${m5[1]}`, 'general')).status === 404);
    check('its media are served after the move back', await mediaServed(admin, p5));

    // --- A moderator whose permission is revoked during the move ----------------
    const mod = new Client();
    const mkMod = await admin.call('POST', '/api/admin/users', null, { username: `${memberName}-mod`, password: memberPass });
    modId = mkMod.json?.id ?? 0;
    check('create moderator', mkMod.status === 201 && (await admin.call('PATCH', `/api/admin/users/${modId}`, null, { permissions: ['profiles'] })).status === 200);
    check('moderator login', await mod.login(`${memberName}-mod`, memberPass));
    const p6 = await upload(admin, A, 1);
    posts.push(p6);
    const move6 = mod.call('PATCH', `/api/posts/${p6}`, null, { author: { creator: B } });
    await wait(DURING_MS);
    const revoke = await admin2.call('PATCH', `/api/admin/users/${modId}`, null, { permissions: [] });
    const r6 = await move6;
    check('permission revoked meanwhile', revoke.status === 200, `${revoke.status}`);
    check('the move under general B answers 409', r6.status === 409, `${r6.status} ${JSON.stringify(r6.json)}`);
    check('the post stays under A, not general', (await admin.get(`/api/posts/${p6}`)).json?.author?.handle === A && (await admin.get(`/api/posts/${p6}`, 'general')).status === 404);

    // --- An item removed by another edit during the move goes home too ----------
    const p7 = await upload(admin, A, 2);
    posts.push(p7);
    const m7: number[] = ((await admin.get(`/api/posts/${p7}`)).json?.media ?? []).map((m: any) => m.id);
    const move7 = admin.call('PATCH', `/api/posts/${p7}`, null, { author: { creator: D } });
    await wait(DURING_MS);
    const rm7 = await admin2.call('PATCH', `/api/posts/${p7}`, null, { removeMedia: [m7[1]] });
    const r7 = await move7;
    check('a removal lands meanwhile', rm7.status === 200, `${rm7.status} ${JSON.stringify(rm7.json)}`);
    check('the move to D answers 409', r7.status === 409, `${r7.status}`);
    check('the kept item is served', await mediaServed(admin, p7));
    if (MEDIA_UPPER) {
      const dir = path.join(MEDIA_UPPER, D);
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : [];
      check('no file is left in the refused destination folder', left.length === 0, left.join(', '));
    }

    // --- A merge queued behind another merge of the same profile -----------------
    for (const h of E) posts.push(await upload(admin, h, 1));
    const merge1 = admin.call('POST', '/api/creators-merge', null, { from: E[0], into: E[1] });
    await wait(DURING_MS);
    const merge2 = await admin2.call('POST', '/api/creators-merge', null, { from: E[2], into: E[0] });
    const r8 = await merge1;
    check('the first merge succeeds', r8.status === 200, `${r8.status} ${JSON.stringify(r8.json)}`);
    check('the queued merge into the merged-away profile answers 409', merge2.status === 409, `${merge2.status} ${JSON.stringify(merge2.json)}`);
    check('the third profile keeps its post', (await admin.get(`/api/posts/${posts[posts.length - 1]}`)).json?.author?.handle === E[2]);
  } finally {
    for (const id of posts) await admin.call('DELETE', `/api/posts/${id}`, null).catch(() => undefined);
    for (const h of [A, B, C, D, ...E]) await admin.call('DELETE', `/api/creators/${h}`, null).catch(() => undefined);
    for (const uid of [memberId, modId]) if (uid) await admin.call('PATCH', `/api/admin/users/${uid}`, null, { disabled: true }).catch(() => undefined);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
