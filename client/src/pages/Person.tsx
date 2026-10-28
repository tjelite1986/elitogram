import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, upload, type Tile } from '../api';
import { Grid } from '../components/Grid';
import { Icon } from '../icons';
import { Avatar, Modal, Switch, errorText, useConfirm, useInfinite, usePageTitle, useSession, useToast } from '../ui';

interface Creator {
  id: number;
  handle: string;
  display_name: string;
  bio: string;
  links: { label: string; url: string }[];
  aliases: string[];
  avatar: string;
  banner: string;
  has_avatar: boolean;
  has_banner: boolean;
  adult: boolean;
  post_count: number;
  follower_count: number;
  following: boolean;
  ig_handle: string | null;
  tiktok_handle: string | null;
  ig_autopoll: boolean;
  tiktok_autopoll: boolean;
  last_sync_at?: number | null;
  last_sync_result?: string | null;
  can_manage: boolean;
}

export function Person() {
  const { handle = '' } = useParams();
  const [c, setC] = useState<Creator | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [bust, setBust] = useState(0);
  const [syncing, setSyncing] = useState('');
  const grid = useInfinite<Tile>(`/api/creators/${encodeURIComponent(handle)}/posts`);
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  usePageTitle(c ? c.display_name || c.handle : handle);

  const load = useCallback(async () => {
    try {
      setC(await get<Creator>(`/api/creators/${encodeURIComponent(handle)}`));
      setError('');
    } catch (err) {
      // A mention can name a user rather than a creator.
      const user = await get(`/api/users/${encodeURIComponent(handle)}`).catch(() => null);
      if (user) nav(`/user/${handle}`, { replace: true });
      else setError(errorText(err));
    }
  }, [handle, nav]);
  const { reload } = grid;
  useEffect(() => {
    void load();
    const onAdult = () => {
      void load();
      reload();
    };
    window.addEventListener('eg-adult', onAdult);
    return () => window.removeEventListener('eg-adult', onAdult);
  }, [load, reload]);

  if (error) return <div className="empty">{error === 'Profile not found' ? 'This profile is not available.' : error}</div>;
  if (!c) return <div className="loading">Loading…</div>;

  const follow = async () => {
    try {
      const r = c.following ? await del(`/api/creators/${c.handle}/follow`) : await post(`/api/creators/${c.handle}/follow`);
      setC({ ...c, following: r.following, follower_count: c.follower_count + (r.following ? 1 : -1) });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  const sync = async (source: 'instagram' | 'tiktok') => {
    setSyncing(source);
    try {
      const label = source === 'instagram' ? 'Instagram' : 'TikTok';
      const before = c.last_sync_at;
      await post(`/api/admin/sources/sync/${c.id}`, { source });
      toast({ text: `${label} sync started` });
      // The server answers at once; wait for the creator's sync stamp to move.
      const deadline = Date.now() + 45 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const fresh = await get(`/api/creators/${encodeURIComponent(c.handle)}`);
        if (fresh.last_sync_at !== before) {
          toast({ text: fresh.last_sync_result ?? `${label} sync finished` });
          break;
        }
        if (Date.now() > deadline) break;
      }
      reload();
      void load();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    } finally {
      setSyncing('');
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${c.handle}?`,
      body: 'The profile and its posts are hidden (soft delete). Files stay on disk and the profile can be restored from Settings > Profiles.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/creators/${c.handle}`);
      toast({ text: `${c.handle} deleted` });
      nav('/people');
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  return (
    <div className="page">
      {c.has_banner && <img className="banner" src={`${c.banner}?v=${bust}`} alt="" />}
      <div className={`profile-head${c.has_banner ? '' : ' no-banner'}`}>
        <Avatar src={`${c.avatar}?v=${bust}`} size={96} />
        <div className="grow" />
        <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
          <button className={`btn small${c.following ? ' secondary' : ''}`} onClick={follow}>
            {c.following ? 'Following' : 'Follow'}
          </button>
          <button className="btn secondary small" onClick={() => setEditing(true)}>
            <Icon name="edit" style={{ width: 16, height: 16 }} /> Edit
          </button>
        </div>
      </div>
      <div className="profile-meta">
        <h2>
          {c.display_name || c.handle} {c.adult && <span className="pill adult">18+</span>}
        </h2>
        <div className="muted">
          @{c.handle}
          {c.aliases.length > 0 && <> · also {c.aliases.join(', ')}</>}
        </div>
        <div className="profile-stats">
          <span>
            <b>{c.post_count}</b> posts
          </span>
          <span>
            <b>{c.follower_count}</b> followers
          </span>
        </div>
        {c.bio && <div className="caption">{c.bio}</div>}
        {c.links.length > 0 && (
          <div className="links">
            {c.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">
                {l.label || l.url.replace(/^https?:\/\//, '')}
              </a>
            ))}
          </div>
        )}
        {(c.ig_handle || c.tiktok_handle) && (
          <div className="row wrap muted" style={{ marginTop: 8, fontSize: 12 }}>
            {c.ig_handle && <span>Instagram: @{c.ig_handle}{c.ig_autopoll ? ' (auto)' : ''}</span>}
            {c.tiktok_handle && <span>TikTok: @{c.tiktok_handle}{c.tiktok_autopoll ? ' (auto)' : ''}</span>}
          </div>
        )}
        {can('sources') && (c.ig_handle || c.tiktok_handle) && (
          <div className="row wrap" style={{ marginTop: 8 }}>
            {c.ig_handle && (
              <button className="btn secondary small" disabled={!!syncing} onClick={() => sync('instagram')}>
                {syncing === 'instagram' ? 'Syncing…' : 'Sync Instagram now'}
              </button>
            )}
            {c.tiktok_handle && (
              <button className="btn secondary small" disabled={!!syncing} onClick={() => sync('tiktok')}>
                {syncing === 'tiktok' ? 'Syncing…' : 'Sync TikTok now'}
              </button>
            )}
            {c.last_sync_result && <span className="hint">{c.last_sync_result}</span>}
          </div>
        )}
      </div>
      <Grid {...grid} empty="No posts yet." />
      {editing && (
        <EditCreator
          c={c}
          onClose={() => setEditing(false)}
          onSaved={(n) => {
            setC(n);
            setBust(Date.now());
          }}
          onDelete={c.can_manage ? remove : undefined}
        />
      )}
    </div>
  );
}

function EditCreator({ c, onClose, onSaved, onDelete }: { c: Creator; onClose: () => void; onSaved: (c: Creator) => void; onDelete?: () => void }) {
  const [f, setF] = useState({
    display_name: c.display_name,
    bio: c.bio,
    links: c.links.map((l) => `${l.label ? l.label + ' ' : ''}${l.url}`).join('\n'),
    aliases: c.aliases.join(', '),
    ig_handle: c.ig_handle ?? '',
    tiktok_handle: c.tiktok_handle ?? '',
    ig_autopoll: c.ig_autopoll,
    tiktok_autopoll: c.tiktok_autopoll,
    adult: c.adult,
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const links = f.links
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = /^(.*?)\s*(https?:\/\/\S+)$/.exec(line);
        return m ? { label: m[1], url: m[2] } : { label: '', url: line };
      });
    const body: Record<string, unknown> = {
      display_name: f.display_name,
      bio: f.bio,
      links,
      aliases: f.aliases.split(/[,\s]+/).filter(Boolean),
    };
    if (c.can_manage) Object.assign(body, { ig_handle: f.ig_handle, tiktok_handle: f.tiktok_handle, ig_autopoll: f.ig_autopoll, tiktok_autopoll: f.tiktok_autopoll, adult: f.adult });
    try {
      onSaved(await patch<Creator>(`/api/creators/${c.handle}`, body));
      onClose();
      toast({ text: 'Profile saved' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const uploadImage = async (kind: 'avatar' | 'banner', file: File | undefined) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await upload(`/api/creators/${c.handle}/${kind}`, fd);
      onSaved(await get<Creator>(`/api/creators/${c.handle}`));
      toast({ text: `${kind === 'avatar' ? 'Picture' : 'Banner'} updated` });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  return (
    <Modal title={`Edit ${c.handle}`} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="row wrap">
          <label className="btn secondary small">
            Change picture
            <input type="file" accept="image/*" hidden onChange={(e) => uploadImage('avatar', e.target.files?.[0])} />
          </label>
          <label className="btn secondary small">
            Change banner
            <input type="file" accept="image/*" hidden onChange={(e) => uploadImage('banner', e.target.files?.[0])} />
          </label>
        </div>
        <label>
          <span className="label">Display name</span>
          <input value={f.display_name} onChange={(e) => set('display_name', e.target.value)} />
        </label>
        <label>
          <span className="label">Bio</span>
          <textarea value={f.bio} onChange={(e) => set('bio', e.target.value)} />
        </label>
        <label>
          <span className="label">Links</span>
          <textarea value={f.links} onChange={(e) => set('links', e.target.value)} placeholder={'Website https://example.com'} rows={3} />
          <span className="hint">One per line: an optional label, then the URL.</span>
        </label>
        <label>
          <span className="label">Aliases</span>
          <input value={f.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="old.handle, other_name" />
          <span className="hint">Other names this person goes by. Imported files that start with an alias land here.</span>
        </label>
        {c.can_manage && (
          <>
            <label>
              <span className="label">Instagram handle to sync from</span>
              <div className="row">
                <input value={f.ig_handle} onChange={(e) => set('ig_handle', e.target.value)} placeholder="remote handle" />
                <Switch checked={f.ig_autopoll} onChange={(v) => set('ig_autopoll', v)} label="Auto-poll Instagram" />
              </div>
            </label>
            <label>
              <span className="label">TikTok handle to sync from</span>
              <div className="row">
                <input value={f.tiktok_handle} onChange={(e) => set('tiktok_handle', e.target.value)} placeholder="remote handle" />
                <Switch checked={f.tiktok_autopoll} onChange={(v) => set('tiktok_autopoll', v)} label="Auto-poll TikTok" />
              </div>
            </label>
            <label className="row" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={f.adult} onChange={(e) => set('adult', e.target.checked)} /> 18+ profile (hidden until the PIN is entered)
            </label>
          </>
        )}
        <div className="modal-actions">
          {onDelete && (
            <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={onDelete}>
              Delete profile
            </button>
          )}
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
