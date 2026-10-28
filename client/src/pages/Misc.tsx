import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post, type Tile } from '../api';
import { Grid } from '../components/Grid';
import { Avatar, errorText, timeAgo, useInfinite, usePageTitle, useSession } from '../ui';

export function Liked() {
  usePageTitle('Liked');
  const grid = useInfinite<Tile>('/api/liked');
  return (
    <div className="page">
      <h1>Liked posts</h1>
      <Grid {...grid} empty="Posts you like show up here." />
    </div>
  );
}

export function Hashtags() {
  usePageTitle('Hashtags');
  const [items, setItems] = useState<{ tag: string; n: number }[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    get('/api/hashtags').then((r) => setItems(r.items));
  }, []);
  const shown = (items ?? []).filter((t) => t.tag.includes(filter.toLowerCase().replace(/^#/, '')));
  return (
    <div className="page narrow">
      <h1>Hashtags</h1>
      <div className="search-bar">
        <input type="search" placeholder="Filter tags" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tags" />
      </div>
      {!items && <div className="loading">Loading…</div>}
      {items && shown.length === 0 && <div className="empty">No hashtags yet.</div>}
      <div className="row wrap" style={{ padding: '0 12px' }}>
        {shown.map((t) => (
          <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`} className="btn secondary small">
            #{t.tag} <span className="muted">{t.n}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Hashtag() {
  const { tag = '' } = useParams();
  usePageTitle(`#${tag}`);
  const grid = useInfinite<Tile>(`/api/hashtags/${encodeURIComponent(tag)}`);
  return (
    <div className="page">
      <h1>#{tag}</h1>
      <Grid {...grid} dense empty="No posts with this tag." />
    </div>
  );
}

/** Resolves an @mention: users first, then creators. */
export function At() {
  const { name = '' } = useParams();
  const nav = useNavigate();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    get(`/api/users/${encodeURIComponent(name)}`)
      .then(() => nav(`/user/${name}`, { replace: true }))
      .catch(() =>
        get(`/api/creators/${encodeURIComponent(name)}`)
          .then(() => nav(`/u/${name}`, { replace: true }))
          .catch(() => setMissing(true)),
      );
  }, [name, nav]);
  return missing ? <div className="empty">No one called @{name} here.</div> : <div className="loading">Loading…</div>;
}

export function Notifications() {
  usePageTitle('Notifications');
  const [items, setItems] = useState<any[] | null>(null);
  const { refresh } = useSession();
  useEffect(() => {
    get('/api/notifications').then((r) => {
      setItems(r.items);
      if (r.items.some((n: any) => !n.read_at)) void post('/api/notifications/read').then(refresh);
    });
  }, [refresh]);
  return (
    <div className="page narrow">
      <h1>Notifications</h1>
      {!items && <div className="loading">Loading…</div>}
      {items && items.length === 0 && <div className="empty">Nothing yet.</div>}
      {items?.map((n) => {
        const to = n.post_id ? `/p/${n.post_id}` : n.creator_handle ? `/u/${n.creator_handle}` : '/';
        return (
          <Link key={n.id} to={to} className={`notif${n.read_at ? '' : ' unread'}`}>
            {n.actor_avatar ? <Avatar src={n.actor_avatar} size={40} /> : <img src="/icon.svg" width={40} height={40} alt="" />}
            <div className="grow">
              <div>{n.text}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {timeAgo(n.created_at)}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function Login() {
  usePageTitle('Log in');
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/api/auth/login', { username, password });
      const next = params.get('next') ?? '/';
      // Only same-site paths; never an absolute URL from the query string.
      location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit} className="stack">
        <div className="brand">Elitogram</div>
        <input placeholder="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Username" autoFocus />
        <input placeholder="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
        <button className="btn" style={{ width: '100%' }} disabled={busy || !username || !password}>
          Log in
        </button>
        {error && <p className="error" style={{ textAlign: 'center' }}>{error}</p>}
      </form>
    </div>
  );
}
