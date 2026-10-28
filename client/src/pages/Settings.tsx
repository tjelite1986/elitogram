import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, upload } from '../api';
import { Avatar, Switch, errorText, timeAgo, useConfirm, usePageTitle, useSession, useToast } from '../ui';

const TABS = [
  { key: 'profile', label: 'My profile' },
  { key: 'adult', label: '18+ access' },
  { key: 'import', label: 'Import', perm: 'import' },
  { key: 'duplicates', label: 'Duplicates', perm: 'duplicates' },
  { key: 'cleaning', label: 'Cleaning', perm: 'cleaning' },
  { key: 'profiles', label: 'Profiles', perm: 'profiles' },
  { key: 'sources', label: 'Sources', perm: 'sources' },
  { key: 'jobs', label: 'Background jobs', perm: 'jobs' },
  { key: 'users', label: 'Users', perm: 'users' },
];

export function Settings() {
  const { tab = 'profile' } = useParams();
  const { can } = useSession();
  usePageTitle('Settings');
  const tabs = TABS.filter((t) => !t.perm || can(t.perm));
  const current = tabs.find((t) => t.key === tab) ?? tabs[0];
  return (
    <div className="page">
      <h1>Settings</h1>
      <nav className="tabs" aria-label="Settings sections">
        {tabs.map((t) => (
          <NavLink key={t.key} to={`/settings/${t.key}`} className={t.key === current.key ? 'active' : ''}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      {current.key === 'profile' && <ProfileTab />}
      {current.key === 'adult' && <AdultTab />}
      {current.key === 'import' && <ImportTab />}
      {current.key === 'duplicates' && <DuplicatesTab />}
      {current.key === 'cleaning' && <CleaningTab />}
      {current.key === 'profiles' && <ProfilesTab />}
      {current.key === 'sources' && <SourcesTab />}
      {current.key === 'jobs' && <JobsTab />}
      {current.key === 'users' && <UsersTab />}
    </div>
  );
}

function useLoad<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    get<T>(url)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

// --- My profile ------------------------------------------------------------------

function urlB64ToUint8(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function ProfileTab() {
  const { me, refresh, vapidKey } = useSession();
  const [f, setF] = useState({ display_name: me!.display_name, bio: me!.bio });
  const [pw, setPw] = useState({ current: '', password: '' });
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on' | 'denied'>('off');
  const toast = useToast();
  const nav = useNavigate();

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushState('unsupported');
    if (Notification.permission === 'denied') return setPushState('denied');
    navigator.serviceWorker.getRegistration().then(async (reg) => setPushState((await reg?.pushManager.getSubscription()) ? 'on' : 'off'));
  }, []);

  const save = async () => {
    try {
      await patch('/api/me', f);
      await refresh();
      toast({ text: 'Profile saved' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const avatar = async (file?: File) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await upload('/api/me/avatar', fd);
      await refresh();
      toast({ text: 'Picture updated' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const changePassword = async () => {
    try {
      await post('/api/me/password', pw);
      setPw({ current: '', password: '' });
      toast({ text: 'Password changed' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const togglePush = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await post('/api/push/unsubscribe', { endpoint: existing.endpoint });
        await existing.unsubscribe();
        setPushState('off');
        return;
      }
      if ((await Notification.requestPermission()) !== 'granted') return setPushState('denied');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidKey) as BufferSource });
      await post('/api/push/subscribe', sub.toJSON());
      setPushState('on');
      toast({ text: 'Push notifications on for this device' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const logout = async () => {
    await post('/api/auth/logout');
    nav('/login');
    location.reload();
  };

  return (
    <>
      <div className="card">
        <div className="row">
          <Avatar src={`${me!.avatar}?v=${Date.now() % 100000}`} size={64} />
          <div className="grow">
            <b>@{me!.username}</b>
            <div className="muted">{me!.role}</div>
          </div>
          <label className="btn secondary small">
            Change picture
            <input type="file" accept="image/*" hidden onChange={(e) => avatar(e.target.files?.[0])} />
          </label>
        </div>
        <label>
          <span className="label">Display name</span>
          <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </label>
        <label>
          <span className="label">Bio</span>
          <textarea value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
        </label>
        <button className="btn" style={{ marginTop: 12 }} onClick={save}>
          Save
        </button>
      </div>
      <div className="card">
        <h3>Notifications</h3>
        {pushState === 'unsupported' && <p className="muted">This browser does not support Web Push. On iPhone, add the app to the home screen first.</p>}
        {pushState === 'denied' && <p className="muted">Notifications are blocked for this site in the browser settings.</p>}
        {(pushState === 'on' || pushState === 'off') && (
          <div className="row">
            <span className="grow">Push notifications on this device</span>
            <Switch checked={pushState === 'on'} onChange={togglePush} label="Push notifications" />
          </div>
        )}
      </div>
      <div className="card">
        <h3>Password</h3>
        <input type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} aria-label="Current password" />
        <input type="password" placeholder="New password (8+ characters)" autoComplete="new-password" style={{ marginTop: 8 }} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} aria-label="New password" />
        <button className="btn" style={{ marginTop: 12 }} onClick={changePassword} disabled={!pw.current || pw.password.length < 8}>
          Change password
        </button>
      </div>
      <div className="card">
        <button className="btn secondary" onClick={logout}>
          Log out
        </button>
      </div>
    </>
  );
}

// --- 18+ -------------------------------------------------------------------------

function AdultTab() {
  const { me, adultUntil, refresh } = useSession();
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [unlock, setUnlock] = useState('');
  const toast = useToast();
  const unlocked = !!adultUntil && adultUntil > Date.now();
  const savePin = async () => {
    try {
      await post('/api/me/pin', { pin, password });
      setPin('');
      setPassword('');
      await refresh();
      toast({ text: 'PIN saved' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const doUnlock = async () => {
    try {
      await post('/api/adult/unlock', { pin: unlock });
      setUnlock('');
      await refresh();
      window.dispatchEvent(new Event('eg-adult'));
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const lock = async () => {
    await post('/api/adult/lock');
    await refresh();
    window.dispatchEvent(new Event('eg-adult'));
  };
  return (
    <>
      <div className="card">
        <h3>Status</h3>
        {unlocked ? (
          <div className="row wrap">
            <span className="grow">18+ content is shown until {new Date(adultUntil!).toLocaleTimeString()}.</span>
            <button className="btn secondary" onClick={lock}>
              Hide now
            </button>
          </div>
        ) : me!.has_pin ? (
          <div className="row">
            <input type="password" inputMode="numeric" placeholder="PIN" value={unlock} onChange={(e) => setUnlock(e.target.value.replace(/\D/g, ''))} aria-label="PIN" />
            <button className="btn" onClick={doUnlock} disabled={unlock.length < 4}>
              Unlock
            </button>
          </div>
        ) : (
          <p className="muted">18+ content is hidden. Set a PIN below to be able to show it.</p>
        )}
      </div>
      <div className="card">
        <h3>{me!.has_pin ? 'Change PIN' : 'Set PIN'}</h3>
        <p className="hint">4-8 digits. Your password confirms the change.</p>
        <input type="password" inputMode="numeric" placeholder="New PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} aria-label="New PIN" />
        <input type="password" placeholder="Password" autoComplete="current-password" style={{ marginTop: 8 }} value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
        <button className="btn" style={{ marginTop: 12 }} onClick={savePin} disabled={pin.length < 4 || !password}>
          Save PIN
        </button>
      </div>
    </>
  );
}

// --- Import ----------------------------------------------------------------------

function ImportTab() {
  const { data, error, reload } = useLoad<any>('/api/admin/import');
  const toast = useToast();
  useEffect(() => {
    if (!data?.job?.running) return;
    const t = setTimeout(reload, 2000);
    return () => clearTimeout(t);
  }, [data, reload]);
  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const run = async () => {
    try {
      await post('/api/admin/import/run');
      toast({ text: 'Import started' });
      setTimeout(reload, 800);
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  return (
    <>
      <div className="card">
        <h3>Drop folder</h3>
        <p className="muted">
          Files in <code>{data.dir}</code> are sorted onto creators: a subfolder names the creator, otherwise the file name must start with a handle or alias (for
          example <code>handle_2024-05-01_1.jpg</code>). Files younger than {Math.round(data.min_age_sec / 60)} minutes are left alone while they upload. A
          <code>.txt</code> next to the files becomes the caption.
        </p>
        <div className="row wrap">
          <button className="btn" onClick={run} disabled={data.job?.running}>
            {data.job?.running ? 'Importing…' : 'Run import now'}
          </button>
          <button className="btn secondary" onClick={reload}>
            Refresh
          </button>
          {data.job?.last_result && <span className="hint">Last run: {data.job.last_result}</span>}
        </div>
        {data.job?.running_log?.length > 0 && <pre className="log">{data.job.running_log.join('\n')}</pre>}
      </div>
      <div className="card">
        <h3>Waiting ({data.pending.length})</h3>
        {data.pending.length === 0 && <p className="muted">The folder is empty.</p>}
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {data.pending.slice(0, 300).map((p: any) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>{(p.size / 1048576).toFixed(1)} MB</td>
                  <td>{p.guess ? `→ ${p.guess}` : <span className="error">no creator match</span>}</td>
                  <td>{p.young ? <span className="muted">still uploading?</span> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.rejected.length > 0 && (
        <div className="card">
          <h3>Rejected ({data.rejected.length})</h3>
          <p className="hint">Moved to .rejected in the import folder: not real media (checked the bytes) or already in the library.</p>
          <pre className="log">{data.rejected.join('\n')}</pre>
        </div>
      )}
    </>
  );
}

// --- Duplicates ------------------------------------------------------------------

function DuplicatesTab() {
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad<any>(`/api/admin/duplicates?status=${status}`, [status]);
  const toast = useToast();
  const decide = async (id: number, s: string) => {
    try {
      await post(`/api/admin/duplicates/${id}`, { status: s });
      reload();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  if (error) return <div className="card error">{error}</div>;
  return (
    <>
      <div className="card">
        <p className="muted">The duplicate scan job reports images that look alike. Nothing is deleted automatically: open a post to delete it yourself, then mark the group resolved.</p>
        <div className="row wrap">
          {['open', 'ignored', 'resolved'].map((s) => (
            <button key={s} className={`btn small${status === s ? '' : ' secondary'}`} onClick={() => setStatus(s)}>
              {s} ({data?.counts?.[s] ?? 0})
            </button>
          ))}
        </div>
      </div>
      {data?.items.length === 0 && <div className="empty">No {status} groups.</div>}
      {data?.items.map((g: any) => (
        <div key={g.id} className="card">
          <div className="dup-grid">
            {g.members.map((m: any) => (
              <Link key={m.media_id} to={`/p/${m.post_id}`} title={m.caption}>
                <img src={m.thumb} alt="" style={m.deleted ? { opacity: 0.35 } : undefined} />
                <div className="hint">
                  {m.handle || 'upload'} · {m.width}×{m.height}
                  {m.deleted ? ' · deleted' : ''}
                </div>
              </Link>
            ))}
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {status !== 'resolved' && (
              <button className="btn small" onClick={() => decide(g.id, 'resolved')}>
                Mark resolved
              </button>
            )}
            {status !== 'ignored' && (
              <button className="btn secondary small" onClick={() => decide(g.id, 'ignored')}>
                Not duplicates (ignore)
              </button>
            )}
            {status !== 'open' && (
              <button className="btn secondary small" onClick={() => decide(g.id, 'open')}>
                Reopen
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

// --- Cleaning --------------------------------------------------------------------

function CleaningTab() {
  const { data, error, reload } = useLoad<any>('/api/admin/cleaning');
  const [selected, setSelected] = useState<number[]>([]);
  const toast = useToast();
  const confirm = useConfirm();
  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const restore = async (ids: number[]) => {
    try {
      await post('/api/admin/cleaning/restore', { ids });
      setSelected([]);
      reload();
      toast({ text: `${ids.length} restored` });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const purge = async () => {
    const ok = await confirm({
      title: `Permanently remove ${selected.length} post(s)?`,
      body: 'Rows are removed and their files deleted, unless another row still uses a file. This cannot be undone.',
      confirmLabel: 'Remove permanently',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await post('/api/admin/cleaning/purge', { ids: selected, confirm: 'PURGE' });
      toast({ text: `${r.posts} posts removed, ${r.files} files deleted, ${r.kept} files kept (still in use)` });
      setSelected([]);
      reload();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  return (
    <>
      <div className="card">
        <h3>Deleted posts ({data.deleted_total})</h3>
        <p className="hint">Deleted posts are only hidden. Restore them, or remove them for good.</p>
        <div className="row wrap" style={{ margin: '8px 0' }}>
          <button className="btn small" disabled={!selected.length} onClick={() => restore(selected)}>
            Restore selected
          </button>
          <button className="btn danger small" disabled={!selected.length} onClick={purge}>
            Remove permanently
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {data.deleted.map((d: any) => (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                      aria-label={`Select post ${d.id}`}
                    />
                  </td>
                  <td>{d.thumb && <img src={d.thumb} width={48} height={48} style={{ objectFit: 'cover', borderRadius: 4 }} alt="" />}</td>
                  <td>
                    <Link to={`/p/${d.id}`}>
                      <b>{d.author}</b> {d.caption.slice(0, 60)}
                    </Link>
                    <div className="hint">
                      {d.media_count} item(s) · deleted {d.deleted_at ? timeAgo(d.deleted_at) : ''} ago
                    </div>
                  </td>
                  <td>
                    <button className="btn secondary small" onClick={() => restore([d.id])}>
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h3>Missing files ({data.missing_total})</h3>
        <p className="hint">Rows whose file is gone from disk (found by the Missing files job). They are hidden, never deleted.</p>
        {data.missing.length > 0 && <pre className="log">{data.missing.map((m: any) => `${m.path}  (post ${m.post_id})`).join('\n')}</pre>}
      </div>
      <div className="card">
        <h3>Profiles without posts ({data.empty_creators.length})</h3>
        <div className="row wrap">
          {data.empty_creators.map((c: any) => (
            <Link key={c.id} className="btn secondary small" to={`/u/${c.handle}`}>
              {c.handle}
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

// --- Profiles --------------------------------------------------------------------

function ProfilesTab() {
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [adult, setAdult] = useState(false);
  const [merge, setMerge] = useState({ from: '', into: '' });
  const deleted = useLoad<any>('/api/creators-deleted');
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const create = async () => {
    try {
      const r = await post('/api/creators', { handle, display_name: name, adult });
      nav(`/u/${r.handle}`);
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const doMerge = async () => {
    const ok = await confirm({
      title: `Merge ${merge.from} into ${merge.into}?`,
      body: `All posts, files, aliases and followers of ${merge.from} move to ${merge.into}. ${merge.from} becomes an alias.`,
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    try {
      const r = await post('/api/creators-merge', merge);
      toast({ text: `${r.moved} posts moved to ${r.into}` });
      nav(`/u/${r.into}`);
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const restore = async (h: string) => {
    try {
      await post(`/api/creators/${h}/restore`);
      deleted.reload();
      toast({ text: `${h} restored` });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  return (
    <>
      <div className="card">
        <h3>New profile</h3>
        <input placeholder="handle (a-z, 0-9, . _ -)" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} aria-label="Handle" />
        <input placeholder="Display name" style={{ marginTop: 8 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
        <label className="row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> 18+ profile
        </label>
        <button className="btn" style={{ marginTop: 12 }} disabled={!handle} onClick={create}>
          Create
        </button>
      </div>
      <div className="card">
        <h3>Merge two profiles</h3>
        <div className="row wrap">
          <input className="grow" placeholder="from (disappears)" value={merge.from} onChange={(e) => setMerge({ ...merge, from: e.target.value.trim() })} aria-label="Merge from" />
          <span>→</span>
          <input className="grow" placeholder="into (kept)" value={merge.into} onChange={(e) => setMerge({ ...merge, into: e.target.value.trim() })} aria-label="Merge into" />
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={!merge.from || !merge.into} onClick={doMerge}>
          Merge
        </button>
      </div>
      <div className="card">
        <h3>Deleted profiles</h3>
        {deleted.data?.items.length === 0 && <p className="muted">None.</p>}
        {deleted.data?.items.map((c: any) => (
          <div key={c.id} className="row" style={{ padding: '4px 0' }}>
            <span className="grow">{c.handle}</span>
            <button className="btn secondary small" onClick={() => restore(c.handle)}>
              Restore
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// --- Sources ---------------------------------------------------------------------

function SourcesTab() {
  const { data, error, reload } = useLoad<any>('/api/admin/sources');
  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [updating, setUpdating] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const add = async () => {
    try {
      await post('/api/admin/sources/cookies', { label, content });
      setLabel('');
      setContent('');
      reload();
      toast({ text: 'Cookie added' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const remove = async (c: any) => {
    if (!(await confirm({ title: `Delete cookie "${c.label}"?`, confirmLabel: 'Delete', danger: true }))) return;
    await del(`/api/admin/sources/cookies/${c.id}`);
    reload();
  };
  const update = async () => {
    setUpdating(true);
    try {
      await post('/api/admin/jobs/update_downloaders/run');
      toast({ text: 'Updating downloaders in the background; see Background jobs' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    } finally {
      setUpdating(false);
    }
  };
  return (
    <>
      <div className="card">
        <h3>Downloaders</h3>
        <p>
          yt-dlp <b>{data.versions.ytDlp}</b> · gallery-dl <b>{data.versions.galleryDl}</b>
        </p>
        <p className="hint">A stale yt-dlp is the most common reason a sync quietly finds nothing.</p>
        {data.can_update && (
          <button className="btn secondary small" onClick={update} disabled={updating}>
            Update now
          </button>
        )}
      </div>
      <div className="card">
        <h3>Instagram cookies</h3>
        <p className="hint">
          Export cookies.txt (Netscape format) from a browser logged in to Instagram. Each creator always uses the same cookie; a cookie that Instagram refuses is
          paused for six hours.
        </p>
        {data.cookies.map((c: any) => (
          <div key={c.id} className="row wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <b className="grow">{c.label}</b>
            {c.cooling && <span className="status-error">paused until {new Date(c.cooldown_until).toLocaleTimeString()}</span>}
            {c.last_error && !c.cooling && <span className="hint" title={c.last_error}>last error</span>}
            {c.last_used_at && <span className="hint">used {timeAgo(c.last_used_at)} ago</span>}
            <Switch checked={!c.disabled} onChange={(v) => patch(`/api/admin/sources/cookies/${c.id}`, { disabled: !v }).then(reload)} label="Enabled" />
            {c.cooling && (
              <button className="btn secondary small" onClick={() => patch(`/api/admin/sources/cookies/${c.id}`, { clear_cooldown: true }).then(reload)}>
                Resume
              </button>
            )}
            <button className="btn danger small" onClick={() => remove(c)}>
              Delete
            </button>
          </div>
        ))}
        <input placeholder="Label (e.g. account name)" style={{ marginTop: 10 }} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Cookie label" />
        <textarea placeholder="# Netscape HTTP Cookie File …" style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 12 }} rows={5} value={content} onChange={(e) => setContent(e.target.value)} aria-label="Cookie file content" />
        <div className="row wrap" style={{ marginTop: 8 }}>
          <label className="btn secondary small">
            Load file…
            <input type="file" accept=".txt,text/plain" hidden onChange={async (e) => setContent((await e.target.files?.[0]?.text()) ?? '')} />
          </label>
          <button className="btn small" disabled={!content} onClick={add}>
            Add cookie
          </button>
        </div>
      </div>
      <div className="card">
        <h3>Profiles with sources ({data.creators.length})</h3>
        <p className="hint">Set handles and auto-poll on each profile's Edit dialog.</p>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {data.creators.map((c: any) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/u/${c.handle}`}>
                      <b>{c.handle}</b>
                    </Link>
                  </td>
                  <td>
                    {c.ig_handle && <div>IG @{c.ig_handle}{c.ig_autopoll ? ' · auto' : ''}</div>}
                    {c.tiktok_handle && <div>TT @{c.tiktok_handle}{c.tiktok_autopoll ? ' · auto' : ''}</div>}
                  </td>
                  <td className="hint">{c.last_sync_result ? `${c.last_sync_result} (${timeAgo(c.last_sync_at)} ago)` : 'never synced'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// --- Jobs ------------------------------------------------------------------------

function JobsTab() {
  const { data, error, reload, setData } = useLoad<any>('/api/admin/jobs');
  const toast = useToast();
  const anyRunning = data?.items.some((j: any) => j.running);
  useEffect(() => {
    const t = setTimeout(reload, anyRunning ? 2000 : 15000);
    return () => clearTimeout(t);
  }, [data, anyRunning, reload]);
  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const change = async (name: string, body: any) => {
    try {
      setData(await patch(`/api/admin/jobs/${name}`, body));
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  const run = async (name: string) => {
    try {
      setData(await post(`/api/admin/jobs/${name}/run`));
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  return (
    <>
      {data.items.map((j: any) => (
        <div key={j.name} className="card" data-job={j.name}>
          <div className="row wrap">
            <h3 className="grow" style={{ margin: 0 }}>
              {j.title}
            </h3>
            <Switch checked={j.enabled} onChange={(v) => change(j.name, { enabled: v })} label={`Enable ${j.title}`} />
          </div>
          <p className="hint" style={{ margin: '4px 0 8px' }}>
            {j.description}
          </p>
          <div className="row wrap">
            <label className="row">
              Every
              <input
                type="number"
                min={1}
                style={{ width: 90 }}
                defaultValue={j.interval_minutes}
                onBlur={(e) => Number(e.target.value) !== j.interval_minutes && change(j.name, { interval_minutes: Number(e.target.value) })}
                aria-label={`${j.title} interval in minutes`}
              />
              min
            </label>
            <button className="btn secondary small" disabled={j.running} onClick={() => run(j.name)}>
              {j.running ? 'Running…' : 'Run once'}
            </button>
            {j.running && (
              <button className="btn secondary small" onClick={() => post(`/api/admin/jobs/${j.name}/stop`).then(reload)}>
                Stop
              </button>
            )}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {j.last_run_at ? (
              <>
                Last run {timeAgo(j.last_run_at)} ago: <span className={j.last_status === 'ok' ? 'status-ok' : 'status-error'}>{j.last_result}</span>
              </>
            ) : (
              'Never run'
            )}
            {j.enabled && j.next_run_at && <> · next {new Date(j.next_run_at).toLocaleString()}</>}
          </div>
          {j.running && j.running_log.length > 0 && <pre className="log">{j.running_log.join('\n')}</pre>}
        </div>
      ))}
    </>
  );
}

// --- Users -----------------------------------------------------------------------

function UsersTab() {
  const { data, error, reload } = useLoad<any>('/api/admin/users');
  const [nu, setNu] = useState({ username: '', password: '', display_name: '' });
  const [badge, setBadge] = useState({ name: '', color: '#3b82f6' });
  const { me } = useSession();
  const toast = useToast();
  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      reload();
      if (msg) toast({ text: msg });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  return (
    <>
      {data.items.map((u: any) => (
        <div key={u.id} className="card">
          <div className="row wrap">
            <Avatar src={`/m/ua/${u.id}`} size={36} />
            <b className="grow">
              {u.username} {u.disabled && <span className="pill">disabled</span>}
            </b>
            <select
              value={u.role}
              style={{ width: 'auto' }}
              disabled={me!.role !== 'admin'}
              onChange={(e) => act(() => patch(`/api/admin/users/${u.id}`, { role: e.target.value }))}
              aria-label="Role"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {u.role !== 'admin' && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              {data.permissions.map((p: string) => (
                <label key={p} className="row" style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={u.permissions.includes(p)}
                    onChange={(e) =>
                      act(() => patch(`/api/admin/users/${u.id}`, { permissions: e.target.checked ? [...u.permissions, p] : u.permissions.filter((x: string) => x !== p) }))
                    }
                  />
                  {p}
                </label>
              ))}
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 8 }}>
            {data.badges.map((b: any) => {
              const has = u.badges.some((x: any) => x.id === b.id);
              return (
                <button
                  key={b.id}
                  className="pill"
                  style={{ background: has ? b.color : 'var(--border)', border: 0, cursor: 'pointer' }}
                  onClick={() =>
                    act(() => patch(`/api/admin/users/${u.id}`, { badges: has ? u.badges.filter((x: any) => x.id !== b.id).map((x: any) => x.id) : [...u.badges.map((x: any) => x.id), b.id] }))
                  }
                >
                  {b.name}
                </button>
              );
            })}
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button
              className="btn secondary small"
              onClick={() => {
                const pw = prompt(`New password for ${u.username} (8+ characters)`);
                if (pw) void act(() => patch(`/api/admin/users/${u.id}`, { password: pw }), 'Password reset');
              }}
            >
              Reset password
            </button>
            {u.has_pin && (
              <button className="btn secondary small" onClick={() => act(() => patch(`/api/admin/users/${u.id}`, { clear_pin: true }), 'PIN cleared')}>
                Clear PIN
              </button>
            )}
            {u.id !== me!.id && (
              <button className="btn secondary small" onClick={() => act(() => patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }))}>
                {u.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="card">
        <h3>New user</h3>
        <input placeholder="username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value.toLowerCase() })} aria-label="Username" />
        <input placeholder="Display name" style={{ marginTop: 8 }} value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} aria-label="Display name" />
        <input placeholder="Password (8+ characters)" type="password" autoComplete="new-password" style={{ marginTop: 8 }} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} aria-label="Password" />
        <button
          className="btn"
          style={{ marginTop: 12 }}
          disabled={!nu.username || nu.password.length < 8}
          onClick={() => act(() => post('/api/admin/users', nu).then(() => setNu({ username: '', password: '', display_name: '' })), 'User created')}
        >
          Create user
        </button>
      </div>
      <div className="card">
        <h3>Badges</h3>
        <div className="row wrap">
          {data.badges.map((b: any) => (
            <span key={b.id} className="pill" style={{ background: b.color }}>
              {b.name}{' '}
              <button style={{ background: 'none', border: 0, color: '#fff', cursor: 'pointer' }} onClick={() => act(() => del(`/api/admin/users/badges/${b.id}`))} aria-label={`Delete badge ${b.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Badge name" value={badge.name} onChange={(e) => setBadge({ ...badge, name: e.target.value })} aria-label="Badge name" />
          <input type="color" value={badge.color} style={{ width: 48, padding: 2 }} onChange={(e) => setBadge({ ...badge, color: e.target.value })} aria-label="Badge color" />
          <button className="btn small" disabled={!badge.name} onClick={() => act(() => post('/api/admin/users/badges', badge).then(() => setBadge({ name: '', color: '#3b82f6' })))}>
            Add
          </button>
        </div>
      </div>
    </>
  );
}
