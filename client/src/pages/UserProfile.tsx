import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, type Tile } from '../api';
import { Grid } from '../components/Grid';
import { Avatar, errorText, useInfinite, usePageTitle } from '../ui';

export function UserProfile() {
  const { username = '' } = useParams();
  const [u, setU] = useState<any>(null);
  const [error, setError] = useState('');
  const grid = useInfinite<Tile>(`/api/users/${encodeURIComponent(username)}/posts`);
  usePageTitle(u ? u.name : username);
  useEffect(() => {
    setU(null);
    get(`/api/users/${encodeURIComponent(username)}`)
      .then(setU)
      .catch((err) => setError(errorText(err)));
  }, [username]);
  if (error) return <div className="empty">{error}</div>;
  if (!u) return <div className="loading">Loading…</div>;
  return (
    <div className="page">
      <div className="profile-head no-banner">
        <Avatar src={u.avatar} size={96} />
        <div className="grow">
          <h2 style={{ margin: 0 }}>{u.name}</h2>
          <div className="muted">@{u.username}</div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            {u.role === 'admin' && <span className="pill">admin</span>}
            {u.badges.map((b: any) => (
              <span key={b.id} className="pill" style={{ background: b.color }}>
                {b.name}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="profile-meta">
        <div className="profile-stats">
          <span>
            <b>{u.post_count}</b> uploads
          </span>
        </div>
        {u.bio && <div className="caption">{u.bio}</div>}
        {u.is_me && (
          <div className="row wrap" style={{ marginTop: 10 }}>
            <Link className="btn secondary small" to="/settings/profile">
              Edit profile
            </Link>
            <Link className="btn secondary small" to="/liked">
              Liked posts
            </Link>
          </div>
        )}
      </div>
      <Grid {...grid} empty={u.is_me ? 'You have not uploaded anything yet.' : 'No uploads yet.'} />
    </div>
  );
}
