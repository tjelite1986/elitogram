import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post as apiPost, type Post } from '../api';
import { Carousel } from '../components/Carousel';
import { MentionInput } from '../components/MentionInput';
import { authorLink, useLike } from '../components/PostCard';
import { Icon } from '../icons';
import { Avatar, Caption, Modal, errorText, shouldIgnoreKey, timeAgo, useConfirm, usePageTitle, useToast } from '../ui';

interface Comment {
  id: number;
  body: string;
  created_at: number;
  user: { id: number; username: string; name: string; avatar: string };
  can_delete: boolean;
}

export function PostPage() {
  const { id } = useParams();
  // Remount per post so no edit state can leak from one post to the next.
  return <PostView key={id} id={Number(id)} />;
}

function PostView({ id }: { id: number }) {
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [authorDialog, setAuthorDialog] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  usePageTitle(post ? `${post.author.handle}: ${post.caption.slice(0, 40)}` : 'Post');

  const load = useCallback(async () => {
    try {
      const p = await get<Post>(`/api/posts/${id}?deleted=1`);
      setPost(p);
      if (!p.deleted) setComments((await get<{ items: Comment[] }>(`/api/posts/${id}/comments`)).items);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);
  useEffect(() => {
    void load();
    window.addEventListener('eg-adult', load);
    return () => window.removeEventListener('eg-adult', load);
  }, [load]);

  const like = useLike(post ?? ({ id, liked: false, like_count: 0 } as Post));
  const likeRef = useRef(like);
  likeRef.current = like;

  // Page shortcuts: arrows move through media, Enter opens the lightbox.
  useEffect(() => {
    if (!post || lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e) || editing !== null) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(post.media.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [post, lightbox, editing]);

  if (error) return <div className="empty">{error === 'Post not found' ? 'This post is not available.' : error}</div>;
  if (!post) return <div className="loading">Loading…</div>;

  const saveCaption = async () => {
    if (editing === null) return;
    const postId = post.id; // captured: the save always targets the post being edited
    setBusy(true);
    try {
      const p = await patch<Post>(`/api/posts/${postId}`, { caption: editing });
      setPost(p);
      setEditing(null);
      toast({ text: 'Caption saved' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const postId = post.id;
    const ok = await confirm({ title: 'Delete post?', body: 'It moves to Cleaning and can be restored.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await del(`/api/posts/${postId}`);
      setPost({ ...post, deleted: true });
      toast({
        text: 'Post deleted',
        action: {
          label: 'Undo',
          run: () => void restore(postId),
        },
      });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  const restore = async (postId: number) => {
    try {
      await apiPost(`/api/posts/${postId}/restore`);
      toast({ text: 'Post restored' });
      if (postId === id) await load();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  const sendComment = async () => {
    const body = comment.trim();
    if (!body) return;
    try {
      await apiPost(`/api/posts/${post.id}/comments`, { body });
      setComment('');
      setComments((await get<{ items: Comment[] }>(`/api/posts/${post.id}/comments`)).items);
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  const removeComment = async (c: Comment) => {
    if (!(await confirm({ title: 'Delete comment?', confirmLabel: 'Delete', danger: true }))) return;
    await del(`/api/comments/${c.id}`).catch((err) => toast({ text: errorText(err), error: true }));
    setComments((list) => list.filter((x) => x.id !== c.id));
  };

  return (
    <>
      {post.deleted && (
        <div className="deleted-banner">
          <b>This post is deleted.</b>
          <button className="btn secondary small" onClick={() => restore(post.id)}>
            Restore
          </button>
        </div>
      )}
      <div className="post-page">
        <header className="post-head">
          <Link to={authorLink(post)}>
            <Avatar src={post.author.avatar} size={34} />
          </Link>
          <div className="grow">
            <Link to={authorLink(post)} style={{ fontWeight: 600 }}>
              {post.author.handle}
            </Link>
            {post.adult && <span className="pill adult" style={{ marginLeft: 6 }}>18+</span>}
          </div>
          {post.source_url && (
            <a className="icon-btn" href={post.source_url} target="_blank" rel="noreferrer noopener" aria-label="Original">
              <Icon name="external" />
            </a>
          )}
          <button className="icon-btn" onClick={() => setLightbox(true)} aria-label="Full screen">
            <Icon name="expand" />
          </button>
        </header>
        <Carousel media={post.media} index={index} onIndex={setIndex} onDoubleTap={() => like.toggle(true)} onOpen={() => setLightbox(true)} style={{ minHeight: 300 }} />
        <div className="post-side">
          <div className="comments">
            {editing !== null ? (
              <div className="stack">
                <MentionInput value={editing} onChange={setEditing} autoFocus rows={5} ariaLabel="Caption" />
                <div className="row">
                  <button className="btn secondary small" onClick={() => setEditing(null)} disabled={busy}>
                    Cancel
                  </button>
                  <button className="btn small" onClick={saveCaption} disabled={busy}>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              post.caption && (
                <div className="comment">
                  <Avatar src={post.author.avatar} size={32} />
                  <div className="grow">
                    <Link to={authorLink(post)} style={{ fontWeight: 600, marginRight: 6 }}>
                      {post.author.handle}
                    </Link>
                    <Caption text={post.caption} />
                    <div className="time">{timeAgo(post.created_at)}</div>
                  </div>
                </div>
              )
            )}
            {comments.map((c) => (
              <div key={c.id} className="comment">
                <Avatar src={c.user.avatar} size={32} />
                <div className="grow">
                  <Link to={`/user/${c.user.username}`} style={{ fontWeight: 600, marginRight: 6 }}>
                    {c.user.username}
                  </Link>
                  <Caption text={c.body} />
                  <div className="time">{timeAgo(c.created_at)}</div>
                </div>
                {c.can_delete && (
                  <button className="icon-btn" onClick={() => removeComment(c)} aria-label="Delete comment">
                    <Icon name="trash" style={{ width: 16, height: 16 }} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="post-actions" style={{ borderTop: '1px solid var(--border)' }}>
            <button className={`icon-btn${like.liked ? ' liked' : ''}`} onClick={() => like.toggle()} aria-label={like.liked ? 'Unlike' : 'Like'}>
              <Icon name="heart" />
            </button>
            <span style={{ fontWeight: 600 }}>{like.count === 1 ? '1 like' : `${like.count} likes`}</span>
            <span className="grow" />
            {post.can_edit && !post.deleted && (
              <>
                <button className="icon-btn" title="Edit caption" aria-label="Edit caption" onClick={() => setEditing(post.caption)}>
                  <Icon name="edit" />
                </button>
                <button className="icon-btn" title="Change author" aria-label="Change author" onClick={() => setAuthorDialog(true)}>
                  <Icon name="user" />
                </button>
                <button className="icon-btn" title="Edit media" aria-label="Edit media" onClick={() => nav(`/p/${post.id}/edit`)}>
                  <Icon name="multi" />
                </button>
                <button className="icon-btn" title="Delete" aria-label="Delete post" onClick={remove}>
                  <Icon name="trash" />
                </button>
              </>
            )}
          </div>
          <div className="time" style={{ padding: '0 12px 8px' }}>
            {new Date(post.created_at).toLocaleString()}
          </div>
          {!post.deleted && (
            <div className="comment-form">
              <div className="grow">
                <MentionInput value={comment} onChange={setComment} rows={1} placeholder="Add a comment…" onSubmit={sendComment} />
              </div>
              <button className="btn ghost" style={{ color: 'var(--accent)' }} disabled={!comment.trim()} onClick={sendComment}>
                Post
              </button>
            </div>
          )}
        </div>
      </div>
      {lightbox && <Lightbox post={post} index={index} setIndex={setIndex} onClose={() => setLightbox(false)} like={like} />}
      {authorDialog && (
        <AuthorDialog
          post={post}
          onClose={() => setAuthorDialog(false)}
          onDone={(p) => {
            setPost(p);
            setAuthorDialog(false);
            toast({ text: `Moved to ${p.author.handle}` });
          }}
        />
      )}
    </>
  );
}

function Lightbox({ post, index, setIndex, onClose, like }: { post: Post; index: number; setIndex: (i: number) => void; onClose: () => void; like: ReturnType<typeof useLike> }) {
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed into a field, or while another dialog is open, are never shortcuts.
      if (shouldIgnoreKey(e, self.current)) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIndex(Math.min(post.media.length - 1, index + 1));
      else if (e.key === 'ArrowLeft') setIndex(Math.max(0, index - 1));
      else if (e.key === 'l') void like.toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, post.media.length, onClose, setIndex, like]);

  return (
    <div className="lightbox" ref={self} data-modal="true" role="dialog" aria-label="Media viewer">
      <div className="lightbox-top">
        <Avatar src={post.author.avatar} size={28} />
        <b className="grow">{post.author.handle}</b>
        <span style={{ opacity: 0.7 }}>
          {index + 1} / {post.media.length}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <Carousel media={post.media} quality="full" index={index} onIndex={setIndex} onDoubleTap={() => like.toggle(true)} showDots={false} />
      <div className="lightbox-bottom">
        <button className={`icon-btn${like.liked ? ' liked' : ''}`} onClick={() => like.toggle()} aria-label="Like">
          <Icon name="heart" />
        </button>
        <span>{like.count}</span>
        <span className="grow" />
        <span style={{ opacity: 0.6, fontSize: 12 }}>← → to browse · L to like · Esc to close</span>
      </div>
    </div>
  );
}

function AuthorDialog({ post, onClose, onDone }: { post: Post; onClose: () => void; onDone: (p: Post) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    const ctrl = new AbortController();
    get(`/api/creators?q=${encodeURIComponent(q)}`, ctrl.signal)
      .then((r) => setItems(r.items.slice(0, 20)))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [q]);
  const move = async (author: { creator?: string; self?: boolean }) => {
    const postId = post.id;
    setBusy(true);
    try {
      onDone(await patch<Post>(`/api/posts/${postId}`, { author }));
    } catch (err) {
      toast({ text: errorText(err), error: true });
      setBusy(false);
    }
  };
  return (
    <Modal title="Change author" onClose={onClose}>
      <input placeholder="Search profiles" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search profiles" />
      <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 8 }}>
        <button className="btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={busy} onClick={() => move({ self: true })}>
          <Icon name="user" /> Me (my own uploads)
        </button>
        {items.map((c) => (
          <button
            key={c.id}
            className="btn ghost"
            style={{ width: '100%', justifyContent: 'flex-start' }}
            disabled={busy || (post.author.type === 'creator' && post.author.id === c.id)}
            onClick={() => move({ creator: c.handle })}
          >
            <Avatar src={c.avatar} size={28} /> {c.handle} <span className="muted">{c.post_count} posts</span>
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
