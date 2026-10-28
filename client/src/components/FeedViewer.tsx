import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { Post } from '../api';
import { Icon } from '../icons';
import { Avatar, Caption, shouldIgnoreKey, useMuted } from '../ui';
import { Carousel } from './Carousel';
import { authorLink, useLike } from './PostCard';

interface Props {
  posts: Post[];
  start: number;
  more: () => void;
  done: boolean;
  onClose: (index: number) => void;
}

// Posts further than this from the current one render as empty frames, so only a handful of originals load at once.
const WINDOW = 2;

/** Full-screen, vertically snapping view of a feed. Each post fills the screen; swipe sideways through its media. */
export function FeedViewer({ posts, start, more, done, onClose }: Props) {
  const self = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(start);
  const activeRef = useRef(active);
  activeRef.current = active;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const c = container.current;
    if (c) c.scrollTop = start * c.clientHeight;
    // Only the opening position; later scrolling is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The back button closes the viewer instead of leaving the feed.
  useEffect(() => {
    history.pushState({ ...history.state, egFeedViewer: true }, '');
    const onPop = () => closeRef.current(activeRef.current);
    window.addEventListener('popstate', onPop);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('popstate', onPop);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const close = () => history.back();

  const goTo = (i: number) => {
    const c = container.current;
    if (!c) return;
    c.scrollTo({ top: Math.max(0, Math.min(posts.length - 1, i)) * c.clientHeight, behavior: 'smooth' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e, self.current)) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown' || e.key === 'j') goTo(activeRef.current + 1);
      else if (e.key === 'ArrowUp' || e.key === 'k') goTo(activeRef.current - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onScroll = () => {
    const c = container.current;
    if (!c) return;
    const i = Math.round(c.scrollTop / c.clientHeight);
    if (i !== active) setActive(i);
    if (!done && i >= posts.length - 3) more();
  };

  return (
    <div className="feed-viewer" ref={self} data-modal="true" role="dialog" aria-label="Full screen feed">
      <button className="icon-btn feed-viewer-close" onClick={close} aria-label="Close">
        <Icon name="close" />
      </button>
      <div className="reels" ref={container} onScroll={onScroll}>
        {posts.map((p, i) => (
          <section className="reel" key={p.id}>
            {Math.abs(i - active) <= WINDOW && <ViewerPost post={p} active={i === active} dialog={self} />}
          </section>
        ))}
      </div>
    </div>
  );
}

function ViewerPost({ post, active, dialog }: { post: Post; active: boolean; dialog: RefObject<HTMLDivElement> }) {
  const like = useLike(post);
  const [index, setIndex] = useState(0);
  const [muted, setMuted] = useMuted();
  const hasVideo = post.media.some((m) => m.kind === 'video');

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e, dialog.current)) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(post.media.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'l') void like.toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, dialog, post.media.length, like]);

  return (
    <>
      <Carousel
        media={post.media}
        quality="full"
        controls={false}
        index={index}
        onIndex={setIndex}
        onDoubleTap={() => like.toggle(true)}
        fill
        style={{ width: '100%', height: '100%' }}
      />
      <div className="reel-info">
        <Link to={authorLink(post)} replace className="row" style={{ fontWeight: 600, marginBottom: 6 }}>
          <Avatar src={post.author.avatar} size={30} /> {post.author.handle}
          {post.adult && <span className="pill adult">18+</span>}
        </Link>
        {post.caption && <Caption text={post.caption} />}
      </div>
      {/* Links replace the viewer's history entry, so Back from them lands on the feed. */}
      <div className="reel-side">
        <button className={`icon-btn${like.liked ? ' liked' : ''}`} onClick={() => like.toggle()} aria-label={like.liked ? 'Unlike' : 'Like'}>
          <Icon name="heart" />
          <span>{like.count}</span>
        </button>
        <Link to={`/p/${post.id}`} replace className="icon-btn" aria-label="Comments">
          <Icon name="comment" />
          <span>{post.comment_count}</span>
        </Link>
        {hasVideo && (
          <button className="icon-btn" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
            <Icon name={muted ? 'muted' : 'sound'} />
          </button>
        )}
      </div>
    </>
  );
}
