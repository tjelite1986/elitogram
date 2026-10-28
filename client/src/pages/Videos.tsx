import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Post, Tile } from '../api';
import { Icon } from '../icons';
import { Avatar, ClampedCaption, useInfinite, useMuted, usePager, usePageTitle } from '../ui';
import { authorLink, useLike } from '../components/PostCard';
import { Grid } from '../components/Grid';

interface Reel {
  media_id: number;
  url: string;
  thumb: string;
  width: number | null;
  height: number | null;
  post: Post;
}

function ReelItem({ reel, active }: { reel: Reel; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useMuted();
  const like = useLike(reel.post);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active) {
      v.currentTime = v.currentTime || 0;
      void v.play().then(() => setPaused(false), () => setPaused(true));
    } else v.pause();
  }, [active]);
  const portrait = (reel.height ?? 16) >= (reel.width ?? 9);
  return (
    <section className="reel">
      <video
        ref={ref}
        className={portrait ? 'portrait' : ''}
        src={reel.url}
        poster={`${reel.thumb}?w=1080`}
        loop
        playsInline
        muted={muted}
        preload={active ? 'auto' : 'metadata'}
        onClick={(e) => {
          const v = e.currentTarget;
          if (v.paused) void v.play().then(() => setPaused(false));
          else {
            v.pause();
            setPaused(true);
          }
        }}
      />
      {paused && active && (
        <div className="heart-pop" style={{ opacity: 0.8 }}>
          <Icon name="play" style={{ width: 72, height: 72, fill: '#fff', stroke: '#fff' }} />
        </div>
      )}
      <div className={`reel-info${expanded ? ' open' : ''}`}>
        <Link to={authorLink(reel.post)} className="row" style={{ fontWeight: 600, marginBottom: 6 }}>
          <Avatar src={reel.post.author.avatar} size={30} /> {reel.post.author.handle}
        </Link>
        {reel.post.caption && <ClampedCaption text={reel.post.caption} open={expanded} onToggle={() => setExpanded(!expanded)} />}
      </div>
      <div className="reel-side">
        <button className={`icon-btn${like.liked ? ' liked' : ''}`} onClick={() => like.toggle()} aria-label="Like">
          <Icon name="heart" />
          <span>{like.count}</span>
        </button>
        <Link to={`/p/${reel.post.id}`} className="icon-btn" aria-label="Comments">
          <Icon name="comment" />
          <span>{reel.post.comment_count}</span>
        </Link>
        <button className="icon-btn" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'muted' : 'sound'} />
        </button>
      </div>
    </section>
  );
}

export function Videos() {
  usePageTitle('Videos');
  const [mode, setMode] = useState<'reels' | 'grid'>(() => {
    try {
      return (localStorage.getItem('eg.videoMode') as 'grid') || 'reels';
    } catch {
      return 'reels';
    }
  });
  const list = useInfinite<Reel>(mode === 'reels' ? '/api/videos' : null);
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const { reload } = list;

  useEffect(() => {
    window.addEventListener('eg-adult', reload);
    return () => window.removeEventListener('eg-adult', reload);
  }, [reload]);

  useEffect(() => {
    try {
      localStorage.setItem('eg.videoMode', mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  usePager(container, list.items.length, { onPage: setActive, enabled: mode === 'reels' });
  const { more } = list;
  useEffect(() => {
    if (active >= list.items.length - 3) more();
  }, [active, list.items.length, more]);

  const toggle = (
    <div className="reels-toggle row">
      <button className="btn secondary small" onClick={() => setMode(mode === 'reels' ? 'grid' : 'reels')} aria-label="Switch view">
        <Icon name={mode === 'reels' ? 'grid' : 'reels'} /> {mode === 'reels' ? 'Grid' : 'Full screen'}
      </button>
    </div>
  );

  if (mode === 'grid') {
    return (
      <div className="page">
        {toggle}
        <h1>Videos</h1>
        <VideoGrid />
      </div>
    );
  }

  return (
    <>
      {toggle}
      <div className="reels" ref={container}>
        <div className="reels-track">
          {list.items.map((r, i) => (
            <ReelItem key={r.media_id} reel={r} active={i === active} />
          ))}
          {!list.loading && list.done && list.items.length === 0 && (
            <div className="empty" style={{ color: '#aaa', paddingTop: 120 }}>
              No videos yet.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function VideoGrid() {
  const list = useInfinite<Reel>('/api/videos');
  const tiles: Tile[] = list.items.map((r) => ({ id: r.post.id, media_id: r.media_id, kind: 'video', thumb: r.thumb, count: 1, has_video: true }));
  return <Grid items={tiles} more={list.more} loading={list.loading} done={list.done} dense empty="No videos yet." />;
}

