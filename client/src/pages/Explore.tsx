import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, type Tile } from '../api';
import { Grid } from '../components/Grid';
import { Icon } from '../icons';
import { Avatar, useInfinite, usePageTitle } from '../ui';

export function Explore() {
  usePageTitle('Explore');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [suggest, setSuggest] = useState<{ creators: any[]; tags: any[] }>({ creators: [], tags: [] });
  const grid = useInfinite<Tile>(`/api/explore${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const { reload } = grid;

  useEffect(() => {
    window.addEventListener('eg-adult', reload);
    return () => window.removeEventListener('eg-adult', reload);
  }, [reload]);

  useEffect(() => {
    const t = text.trim();
    if (!t) {
      setSuggest({ creators: [], tags: [] });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      get(`/api/search?q=${encodeURIComponent(t)}`, ctrl.signal)
        .then(setSuggest)
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text]);

  return (
    <div className="page">
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(text.trim() ? { q: text.trim() } : {});
        }}
      >
        <div className="row">
          <input type="search" placeholder="Search creators, captions or #hashtags" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
          <button className="btn" aria-label="Search">
            <Icon name="search" />
          </button>
        </div>
        {text.trim() && text.trim() !== q && (suggest.creators.length > 0 || suggest.tags.length > 0) && (
          <div className="suggest">
            {suggest.creators.map((c) => (
              <Link key={c.id} to={`/u/${c.handle}`}>
                <Avatar src={c.avatar} size={32} />
                <span>
                  <b>{c.handle}</b> <span className="muted">{c.display_name}</span>
                </span>
              </Link>
            ))}
            {suggest.tags.map((t) => (
              <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`}>
                <span className="avatar row" style={{ width: 32, height: 32, justifyContent: 'center', border: '1px solid var(--border)' }}>
                  #
                </span>
                <span>
                  <b>#{t.tag}</b> <span className="muted">{t.n} posts</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </form>
      {q && <h1 style={{ marginTop: 0 }}>Results for “{q}”</h1>}
      <Grid {...grid} dense empty={q ? 'No posts match.' : 'The library is empty.'} />
    </div>
  );
}
