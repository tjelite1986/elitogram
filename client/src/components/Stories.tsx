import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, post, upload } from '../api';
import { Icon } from '../icons';
import { Avatar, Modal, errorText, shouldIgnoreKey, timeAgo, useConfirm, useMuted, useSession, useToast } from '../ui';

interface StoryItem {
  id: number;
  kind: 'image' | 'video';
  url: string;
  created_at: number;
  seen: boolean;
  adult: boolean;
}
interface StoryGroup {
  user: { id: number; username: string; name: string; avatar: string };
  items: StoryItem[];
  all_seen: boolean;
  mine: boolean;
}

export function StoryRail() {
  const { me } = useSession();
  const [groups, setGroups] = useState<StoryGroup[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [adult, setAdult] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = useCallback(() => {
    get<{ items: StoryGroup[] }>('/api/stories')
      .then((r) => setGroups(r.items))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('eg-adult', load);
    return () => window.removeEventListener('eg-adult', load);
  }, [load]);

  const send = async () => {
    if (!pending) return;
    const fd = new FormData();
    fd.append('file', pending);
    if (adult) fd.append('adult', '1');
    setUploading(true);
    try {
      await upload('/api/stories', fd);
      toast({ text: 'Story shared' });
      setPending(null);
      setAdult(false);
      load();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    } finally {
      setUploading(false);
    }
  };

  const mine = groups.find((g) => g.mine);
  return (
    <>
      <div className="story-rail">
        <button className="story-chip" onClick={() => (mine ? setOpen(groups.indexOf(mine)) : fileRef.current?.click())} aria-label="Your story">
          <div className={`ring${mine ? (mine.all_seen ? ' seen' : '') : ' seen'}`}>
            <Avatar src={me!.avatar} size={58} />
            <span
              className="plus"
              role="button"
              aria-label="Add to your story"
              onClick={(e) => {
                e.stopPropagation();
                fileRef.current?.click();
              }}
            >
              +
            </span>
          </div>
          <span>Your story</span>
        </button>
        {groups.map((g, i) =>
          g.mine ? null : (
            <button key={g.user.id} className="story-chip" onClick={() => setOpen(i)}>
              <div className={`ring${g.all_seen ? ' seen' : ''}`}>
                <Avatar src={g.user.avatar} size={58} />
              </div>
              <span>{g.user.username}</span>
            </button>
          ),
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            setPending(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
      </div>
      {pending && (
        <Modal title="New story" onClose={() => !uploading && setPending(null)}>
          <p className="muted">
            {pending.name} · {(pending.size / 1048576).toFixed(1)} MB · visible for 24 hours
          </p>
          <label className="row">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> 18+ content
          </label>
          <div className="modal-actions">
            <button className="btn secondary" onClick={() => setPending(null)} disabled={uploading}>
              Cancel
            </button>
            <button className="btn" onClick={send} disabled={uploading}>
              {uploading ? 'Sharing…' : 'Share'}
            </button>
          </div>
        </Modal>
      )}
      {open !== null && groups[open] && (
        <StoryViewer
          groups={groups}
          start={open}
          onClose={() => {
            setOpen(null);
            load();
          }}
        />
      )}
    </>
  );
}

function StoryViewer({ groups, start, onClose }: { groups: StoryGroup[]; start: number; onClose: () => void }) {
  const [gi, setGi] = useState(start);
  const [ii, setIi] = useState(() => Math.max(0, groups[start].items.findIndex((s) => !s.seen)));
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState<any[] | null>(null);
  const [muted, setMuted] = useMuted();
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const group = groups[gi];
  const item = group?.items[ii];

  const next = useCallback(() => {
    setProgress(0);
    if (ii < group.items.length - 1) setIi(ii + 1);
    else if (gi < groups.length - 1) {
      setGi(gi + 1);
      setIi(0);
    } else onClose();
  }, [gi, ii, group, groups.length, onClose]);
  const prev = useCallback(() => {
    setProgress(0);
    if (ii > 0) setIi(ii - 1);
    else if (gi > 0) {
      setGi(gi - 1);
      setIi(0);
    }
  }, [gi, ii]);

  useEffect(() => {
    if (item && !item.seen) {
      item.seen = true;
      void post(`/api/stories/${item.id}/view`).catch(() => undefined);
    }
  }, [item]);

  // Images advance after five seconds; videos follow their own clock.
  useEffect(() => {
    if (!item || paused || viewers) return;
    if (item.kind === 'video') return;
    const started = Date.now() - progress * 5000;
    const iv = setInterval(() => {
      const p = (Date.now() - started) / 5000;
      if (p >= 1) next();
      else setProgress(p);
    }, 50);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, paused, viewers, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e, frameRef.current?.closest('[data-modal]') as HTMLElement)) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  if (!item) return null;

  const remove = async () => {
    setPaused(true);
    const ok = await confirm({ title: 'Delete this story?', confirmLabel: 'Delete', danger: true });
    setPaused(false);
    if (!ok) return;
    try {
      await del(`/api/stories/${item.id}`);
      onClose();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  return (
    <div className="story-viewer" data-modal="true">
      <div className="story-frame" ref={frameRef} onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)}>
        <div className="story-bars">
          {group.items.map((s, i) => (
            <div key={s.id}>
              <i style={{ width: `${i < ii ? 100 : i === ii ? progress * 100 : 0}%` }} />
            </div>
          ))}
        </div>
        <div className="story-head">
          <Avatar src={group.user.avatar} size={32} />
          <b>{group.user.username}</b>
          <span style={{ opacity: 0.8 }}>{timeAgo(item.created_at)}</span>
          <span className="grow" />
          {item.kind === 'video' && (
            <button className="icon-btn" style={{ color: '#fff' }} onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
              <Icon name={muted ? 'muted' : 'sound'} />
            </button>
          )}
          <button className="icon-btn" style={{ color: '#fff' }} onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {item.kind === 'image' ? (
          <img src={item.url} alt="" />
        ) : (
          <video
            key={item.id}
            ref={videoRef}
            src={item.url}
            autoPlay
            playsInline
            muted={muted}
            onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
            onEnded={next}
          />
        )}
        <button className="story-tap left" aria-label="Previous" onClick={prev} />
        <button className="story-tap right" aria-label="Next" onClick={next} />
        {group.mine && (
          <div className="story-foot">
            <button
              className="btn secondary small"
              onClick={async () => {
                setPaused(true);
                const r = await get(`/api/stories/${item.id}/viewers`);
                setViewers(r.items);
              }}
            >
              <Icon name="eye" /> Seen by
            </button>
            <span className="grow" />
            <button className="btn danger small" onClick={remove}>
              <Icon name="trash" /> Delete
            </button>
          </div>
        )}
      </div>
      {viewers && (
        <Modal
          title="Seen by"
          onClose={() => {
            setViewers(null);
            setPaused(false);
          }}
        >
          {viewers.length === 0 && <p className="muted">No one yet.</p>}
          {viewers.map((v) => (
            <div key={v.id} className="row" style={{ padding: '6px 0' }}>
              <Avatar src={v.avatar} size={32} />
              <b className="grow">{v.username}</b>
              <span className="muted">{timeAgo(v.viewed_at)}</span>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
