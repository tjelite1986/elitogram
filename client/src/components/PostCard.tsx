import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, post as apiPost, type Post } from '../api';
import { Icon } from '../icons';
import { Avatar, Caption, errorText, timeAgo, useToast } from '../ui';
import { Carousel, aspectFor } from './Carousel';

export function authorLink(p: Post): string {
  return p.author.type === 'creator' ? `/u/${p.author.handle}` : `/user/${p.author.handle}`;
}

export function useLike(initial: Post, onChange?: (p: Post) => void) {
  const [state, setState] = useState({ liked: initial.liked, count: initial.like_count });
  const toast = useToast();
  useEffect(() => {
    setState({ liked: initial.liked, count: initial.like_count });
  }, [initial.id, initial.liked, initial.like_count]);
  const toggle = async (force?: boolean) => {
    const want = force ?? !state.liked;
    if (want === state.liked) return;
    const prev = state;
    setState({ liked: want, count: state.count + (want ? 1 : -1) });
    try {
      const r = want ? await apiPost(`/api/posts/${initial.id}/like`) : await del(`/api/posts/${initial.id}/like`);
      setState({ liked: r.liked, count: r.like_count });
      onChange?.({ ...initial, liked: r.liked, like_count: r.like_count });
    } catch (err) {
      setState(prev);
      toast({ text: errorText(err), error: true });
    }
  };
  return { ...state, toggle };
}

export function PostCard({ post, onOpen }: { post: Post; onOpen?: () => void }) {
  const like = useLike(post);
  const [expanded, setExpanded] = useState(false);
  const long = post.caption.length > 140;
  return (
    <article className="post-card" id={`post-${post.id}`}>
      <header className="post-head">
        <Link to={authorLink(post)}>
          <Avatar src={post.author.avatar} size={34} />
        </Link>
        <div className="grow">
          <Link to={authorLink(post)} className="name">
            {post.author.handle}
          </Link>
          {post.adult && <span className="pill adult" style={{ marginLeft: 6 }}>18+</span>}
          <div className="muted" style={{ fontSize: 12 }}>
            {post.author.name !== post.author.handle ? post.author.name : ''}
          </div>
        </div>
        <Link to={`/p/${post.id}`} className="icon-btn" aria-label="Open post">
          <Icon name="more" />
        </Link>
      </header>
      <Carousel
        media={post.media}
        className="post-media"
        style={{ aspectRatio: String(aspectFor(post.media[0])) }}
        onDoubleTap={() => like.toggle(true)}
        onOpen={onOpen && (() => onOpen())}
        fill
      />
      <div className="post-actions">
        <button className={`icon-btn${like.liked ? ' liked' : ''}`} aria-label={like.liked ? 'Unlike' : 'Like'} onClick={() => like.toggle()}>
          <Icon name="heart" />
        </button>
        <Link className="icon-btn" to={`/p/${post.id}`} aria-label="Comments">
          <Icon name="comment" />
        </Link>
      </div>
      <div className="post-body">
        {like.count > 0 && <div className="likes">{like.count === 1 ? '1 like' : `${like.count} likes`}</div>}
        {post.caption && (
          <div>
            <Link to={authorLink(post)} style={{ fontWeight: 600, marginRight: 6 }}>
              {post.author.handle}
            </Link>
            {long && !expanded ? (
              <>
                <Caption text={post.caption.slice(0, 140).trimEnd() + '…'} />{' '}
                <button className="btn ghost small muted" style={{ padding: 0 }} onClick={() => setExpanded(true)}>
                  more
                </button>
              </>
            ) : (
              <Caption text={post.caption} />
            )}
          </div>
        )}
        {post.comment_count > 0 && (
          <Link to={`/p/${post.id}`} className="muted" style={{ display: 'block', marginTop: 4 }}>
            View {post.comment_count === 1 ? '1 comment' : `all ${post.comment_count} comments`}
          </Link>
        )}
        <div className="time">{timeAgo(post.created_at)}</div>
      </div>
    </article>
  );
}
