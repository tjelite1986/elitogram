import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Sentinel, useInfinite, usePageTitle } from '../ui';

interface CreatorRow {
  id: number;
  handle: string;
  display_name: string;
  adult: boolean;
  post_count: number;
  avatar: string;
}

export function People() {
  usePageTitle('People');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useInfinite<CreatorRow>(`/api/creators${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const { reload } = list;
  useEffect(() => {
    window.addEventListener('eg-adult', reload);
    return () => window.removeEventListener('eg-adult', reload);
  }, [reload]);
  return (
    <div className="page">
      <div className="search-bar">
        <input type="search" placeholder="Search people" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search people" />
      </div>
      <div className="people">
        {list.items.map((c) => (
          <Link key={c.id} to={`/u/${c.handle}`} className="person">
            <Avatar src={c.avatar} size={72} />
            <span className="name">{c.display_name || c.handle}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              @{c.handle}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {c.post_count} posts {c.adult && <span className="pill adult">18+</span>}
            </span>
          </Link>
        ))}
      </div>
      {list.loading && <div className="loading">Loading…</div>}
      {!list.loading && list.done && list.items.length === 0 && <div className="empty">No people found.</div>}
      <Sentinel onVisible={list.more} disabled={list.done} />
    </div>
  );
}
