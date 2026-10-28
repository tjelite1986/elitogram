import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, upload, type Post } from '../api';
import { MentionInput } from '../components/MentionInput';
import { Icon } from '../icons';
import { Avatar, errorText, useConfirm, usePageTitle, useToast } from '../ui';

function CreatorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [q, setQ] = useState(value);
  const [items, setItems] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    get(`/api/creators?q=${encodeURIComponent(q)}`, ctrl.signal)
      .then((r) => setItems(r.items.slice(0, 8)))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [q, open]);
  return (
    <div className="mention-wrap">
      <input
        value={q}
        placeholder="Me (leave empty) or a creator handle"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          onChange(e.target.value.trim());
        }}
        aria-label="Post as"
      />
      {open && items.length > 0 && (
        <div className="mention-list">
          {items.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQ(c.handle);
                onChange(c.handle);
                setOpen(false);
              }}
            >
              <Avatar src={c.avatar} size={26} /> <b>{c.handle}</b> <span className="muted">{c.display_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Create() {
  usePageTitle('New post');
  const [files, setFiles] = useState<File[]>([]);
  const [caption, setCaption] = useState('');
  const [creator, setCreator] = useState('');
  const [adult, setAdult] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const previews = useMemo(() => files.map((f) => ({ f, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const add = (list: FileList | null) => {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list).filter((f) => /^(image|video)\//.test(f.type) || /\.(jpe?g|png|gif|webp|avif|mp4|mov|webm|m4v)$/i.test(f.name))]);
  };
  const move = (i: number, d: number) =>
    setFiles((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files.length) return;
    const fd = new FormData();
    fd.append('caption', caption);
    if (creator) fd.append('creator', creator);
    if (adult) fd.append('adult', '1');
    files.forEach((f) => fd.append('files', f, f.name));
    setProgress(0);
    try {
      const r = await upload<{ id: number; rejected: { name: string; reason: string }[] }>('/api/posts', fd, setProgress);
      if (r.rejected.length) toast({ text: `Skipped: ${r.rejected.map((x) => `${x.name} (${x.reason})`).join(', ')}`, error: true });
      nav(`/p/${r.id}`);
    } catch (err) {
      toast({ text: errorText(err), error: true });
      setProgress(null);
    }
  };

  return (
    <div className="page narrow page-pad">
      <h1 style={{ margin: '0 0 12px' }}>New post</h1>
      <form onSubmit={submit} className="stack">
        <label
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            add(e.dataTransfer.files);
          }}
        >
          <Icon name="plus" style={{ width: 36, height: 36, margin: '0 auto 6px' }} />
          <div>Choose photos and videos, or drop them here</div>
          <input type="file" multiple accept="image/*,video/*" hidden onChange={(e) => add(e.target.files)} />
        </label>
        {previews.length > 0 && (
          <div className="previews">
            {previews.map((p, i) => (
              <div className="preview" key={p.url}>
                {p.f.type.startsWith('video') ? <video src={p.url} muted playsInline /> : <img src={p.url} alt="" />}
                <div className="preview-tools">
                  <button type="button" onClick={() => move(i, -1)} aria-label="Move left">
                    ‹
                  </button>
                  <button type="button" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label="Remove">
                    ✕
                  </button>
                  <button type="button" onClick={() => move(i, 1)} aria-label="Move right">
                    ›
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div>
          <span className="label">Caption</span>
          <MentionInput value={caption} onChange={setCaption} placeholder="Write a caption… use @ to mention and # for tags" ariaLabel="Caption" />
        </div>
        <div>
          <span className="label">Post as</span>
          <CreatorPicker value={creator} onChange={setCreator} />
        </div>
        <label className="row">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> 18+ content
        </label>
        {progress !== null && (
          <div className="progress" aria-label="Upload progress">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <button className="btn" disabled={!files.length || progress !== null}>
          {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Share'}
        </button>
      </form>
    </div>
  );
}

export function EditPost() {
  const { id } = useParams();
  const postId = Number(id);
  usePageTitle('Edit post');
  const [p, setP] = useState<Post | null>(null);
  const [caption, setCaption] = useState('');
  const [order, setOrder] = useState<number[]>([]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const load = async () => {
    const r = await get<Post>(`/api/posts/${postId}`);
    setP(r);
    setCaption(r.caption);
    setOrder(r.media.map((m) => m.id));
    setAdult(r.adult);
    setRemoved([]);
  };
  useEffect(() => {
    load().catch((err) => toast({ text: errorText(err), error: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  if (!p) return <div className="loading">Loading…</div>;
  const byId = new Map(p.media.map((m) => [m.id, m]));
  const kept = order.filter((mid) => !removed.includes(mid));

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= kept.length) return;
    const next = [...kept];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder([...next, ...removed]);
  };

  const save = async () => {
    if (kept.length === 0) return toast({ text: 'A post needs at least one item', error: true });
    if (removed.length && !(await confirm({ title: `Remove ${removed.length} item(s)?`, body: 'Removed items are kept as a deleted post in Cleaning.', confirmLabel: 'Remove' }))) return;
    setBusy(true);
    try {
      await patch(`/api/posts/${postId}`, { caption, order: kept, removeMedia: removed, adult });
      nav(`/p/${postId}`);
    } catch (err) {
      toast({ text: errorText(err), error: true });
      setBusy(false);
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const fd = new FormData();
    Array.from(list).forEach((f) => fd.append('files', f, f.name));
    setProgress(0);
    try {
      const r = await upload(`/api/posts/${postId}/media`, fd, setProgress);
      if (r.rejected.length) toast({ text: `Skipped: ${r.rejected.map((x: any) => x.name).join(', ')}`, error: true });
      await load();
    } catch (err) {
      toast({ text: errorText(err), error: true });
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="page narrow page-pad stack">
      <h1 style={{ margin: 0 }}>Edit post</h1>
      <div className="previews">
        {kept.map((mid, i) => {
          const m = byId.get(mid)!;
          return (
            <div className="preview" key={mid}>
              <img src={m.thumb} alt="" />
              <div className="preview-tools">
                <button type="button" onClick={() => move(i, -1)} aria-label="Move left">
                  ‹
                </button>
                <button type="button" onClick={() => setRemoved((r) => [...r, mid])} aria-label="Remove">
                  ✕
                </button>
                <button type="button" onClick={() => move(i, 1)} aria-label="Move right">
                  ›
                </button>
              </div>
            </div>
          );
        })}
        <label className="preview dropzone" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <Icon name="plus" />
          <input type="file" multiple accept="image/*,video/*" hidden onChange={(e) => addFiles(e.target.files)} />
        </label>
      </div>
      {removed.length > 0 && (
        <div className="hint">
          {removed.length} item(s) will be removed.{' '}
          <button className="btn ghost small" onClick={() => setRemoved([])}>
            Undo
          </button>
        </div>
      )}
      {progress !== null && (
        <div className="progress">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div>
        <span className="label">Caption</span>
        <MentionInput value={caption} onChange={setCaption} rows={5} ariaLabel="Caption" />
      </div>
      <label className="row">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> 18+ content
      </label>
      <div className="row">
        <button className="btn secondary" onClick={() => nav(`/p/${postId}`)}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
}
