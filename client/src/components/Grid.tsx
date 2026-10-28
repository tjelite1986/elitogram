import { Link } from 'react-router-dom';
import type { Tile } from '../api';
import { Icon } from '../icons';
import { Sentinel } from '../ui';

export function Grid({ items, more, loading, done, dense, empty = 'Nothing here yet.' }: { items: Tile[]; more: () => void; loading: boolean; done: boolean; dense?: boolean; empty?: string }) {
  return (
    <>
      <div className={`grid${dense ? ' dense' : ''}`}>
        {items.map((t) => (
          <Link key={`${t.id}-${t.media_id}`} to={`/p/${t.id}`} className="tile">
            <img src={t.thumb} alt="" loading="lazy" />
            {(t.count > 1 || t.has_video) && (
              <span className="tile-icon">
                <Icon name={t.count > 1 ? 'multi' : 'play'} />
              </span>
            )}
          </Link>
        ))}
      </div>
      {loading && <div className="loading">Loading…</div>}
      {!loading && done && items.length === 0 && <div className="empty">{empty}</div>}
      <Sentinel onVisible={more} disabled={done} />
    </>
  );
}
