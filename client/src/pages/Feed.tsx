import { useEffect, useState } from 'react';
import type { Post } from '../api';
import { FeedViewer } from '../components/FeedViewer';
import { PostCard } from '../components/PostCard';
import { Icon } from '../icons';
import { StoryRail } from '../components/Stories';
import { Sentinel, useInfinite, usePageTitle } from '../ui';

export function Feed() {
  usePageTitle('');
  const [following, setFollowing] = useState(false);
  const feed = useInfinite<Post>(`/api/feed${following ? '?following=1' : ''}`);
  const { reload } = feed;
  const [viewer, setViewer] = useState<number | null>(null);
  useEffect(() => {
    window.addEventListener('eg-adult', reload);
    return () => window.removeEventListener('eg-adult', reload);
  }, [reload]);
  return (
    <div className="page feed">
      <StoryRail />
      <div className="row" style={{ padding: '8px 12px', gap: 6 }}>
        <button className={`btn small ${following ? 'secondary' : ''}`} onClick={() => setFollowing(false)}>
          For you
        </button>
        <button className={`btn small ${following ? '' : 'secondary'}`} onClick={() => setFollowing(true)}>
          Following
        </button>
        <span className="grow" />
        {feed.items.length > 0 && (
          <button className="btn small secondary" onClick={() => setViewer(0)} aria-label="Full screen">
            <Icon name="expand" /> Full screen
          </button>
        )}
      </div>
      {feed.items.map((p, i) => (
        <PostCard key={p.id} post={p} onOpen={() => setViewer(i)} />
      ))}
      {feed.loading && <div className="loading">Loading…</div>}
      {feed.error && <div className="empty error">{feed.error}</div>}
      {!feed.loading && feed.done && feed.items.length === 0 && (
        <div className="empty">{following ? 'Follow some people to fill this feed.' : 'No posts yet. Create one, or drop files in the import folder.'}</div>
      )}
      <Sentinel onVisible={feed.more} disabled={feed.done} />
      {viewer !== null && (
        <FeedViewer
          posts={feed.items}
          start={viewer}
          more={feed.more}
          done={feed.done}
          onClose={(i) => {
            setViewer(null);
            // Leave the feed at the post that was on screen.
            requestAnimationFrame(() => document.getElementById(`post-${feed.items[i]?.id}`)?.scrollIntoView({ block: 'start' }));
          }}
        />
      )}
    </div>
  );
}
