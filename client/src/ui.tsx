import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { get, type Me, type Page } from './api';

// --- Session context -----------------------------------------------------------

interface Session {
  me: Me | null;
  adultUntil: number | null;
  unread: number;
  vapidKey: string;
  loaded: boolean;
  refresh: () => Promise<void>;
  can: (perm: string) => boolean;
}

const SessionCtx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Session, 'refresh' | 'can'>>({ me: null, adultUntil: null, unread: 0, vapidKey: '', loaded: false });
  const refresh = useCallback(async () => {
    try {
      const r = await get<any>('/api/me');
      setState({ me: r.user, adultUntil: r.adult_until ?? null, unread: r.unread ?? 0, vapidKey: r.vapid_key ?? '', loaded: true });
    } catch {
      setState((s) => ({ ...s, loaded: true }));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const iv = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(iv);
  }, [refresh]);
  const can = useCallback((perm: string) => !!state.me && (state.me.role === 'admin' || state.me.permissions.includes(perm)), [state.me]);
  return <SessionCtx.Provider value={{ ...state, refresh, can }}>{children}</SessionCtx.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}

// --- Toasts --------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}

const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq;
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.action ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((list) => list.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Modals and confirm ----------------------------------------------------------

/** True while any modal dialog is open; global shortcuts must stand down. */
export function modalOpen(): boolean {
  return !!document.querySelector('[data-modal="true"]');
}

/** Global keyboard shortcuts ignore keys typed into fields or while a dialog is open. */
export function shouldIgnoreKey(e: KeyboardEvent, ownDialog?: HTMLElement | null): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return true;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return true;
  const modals = [...document.querySelectorAll('[data-modal="true"]')].filter((m) => m !== ownDialog);
  return modals.length > 0;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="modal-backdrop" data-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(() => Promise.resolve(false));

/**
 * One confirmation at a time. Escape, the backdrop, Cancel or a newer request
 * all resolve the pending one with false, so nothing is left waiting to fire later.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const ask = useCallback((o: ConfirmOpts) => {
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => setPending({ ...o, resolve }));
  }, []);
  const finish = (v: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(v);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {pending && (
        <Modal title={pending.title} onClose={() => finish(false)}>
          {pending.body && <div className="muted">{pending.body}</div>}
          <div className="modal-actions">
            <button className="btn secondary" onClick={() => finish(false)}>
              Cancel
            </button>
            <button className={`btn${pending.danger ? ' danger' : ''}`} onClick={() => finish(true)} autoFocus>
              {pending.confirmLabel ?? 'OK'}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

// --- Small components ------------------------------------------------------------

const FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#8884"/></svg>');

/** The server answers missing avatars with a generated picture; onError only covers network failures. */
export function Avatar({ src, size = 32, alt = '' }: { src: string; size?: number; alt?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <img
      className="avatar"
      src={failed ? FALLBACK : src}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function timeAgo(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString(undefined, { year: d > 300 ? 'numeric' : undefined, month: 'short', day: 'numeric' });
}

/** Caption text with #tags and @mentions linked. */
export function Caption({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /([#@])([\p{L}\p{N}_.]+)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    const before = m.index === 0 ? '' : text[m.index - 1];
    if (before && /[\p{L}\p{N}_]/u.test(before)) continue;
    parts.push(text.slice(last, m.index));
    const name = m[2].replace(/\.+$/, '');
    if (m[1] === '#') {
      parts.push(
        <Link key={i++} className="tag" to={`/tags/${encodeURIComponent(name.toLowerCase())}`}>
          #{name}
        </Link>,
      );
    } else {
      parts.push(
        <Link key={i++} className="mention" to={`/at/${encodeURIComponent(name.toLowerCase())}`}>
          @{name}
        </Link>,
      );
    }
    last = m.index + 1 + name.length;
  }
  parts.push(text.slice(last));
  return <span className="caption">{parts}</span>;
}

// --- Infinite lists --------------------------------------------------------------

export function useInfinite<T>(url: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const busy = useRef(false);

  const load = useCallback(
    async (cursor: string | number | null, reset: boolean) => {
      if (!url || busy.current) return;
      busy.current = true;
      const my = gen.current;
      setLoading(true);
      try {
        const sep = url.includes('?') ? '&' : '?';
        const key = typeof cursor === 'number' ? 'offset' : 'cursor';
        const page = await get<Page<T>>(cursor !== null ? `${url}${sep}${key}=${encodeURIComponent(String(cursor))}` : url);
        if (my !== gen.current) return;
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
        setNext(page.next);
        setDone(page.next === null);
        setError(null);
      } catch (err) {
        if (my === gen.current) setError(errorText(err));
      } finally {
        busy.current = false;
        if (my === gen.current) setLoading(false);
      }
    },
    [url],
  );

  useEffect(() => {
    gen.current++;
    busy.current = false;
    setItems([]);
    setNext(null);
    setDone(false);
    void load(null, true);
  }, [load]);

  const more = useCallback(() => {
    if (!done && next !== null) void load(next, false);
  }, [done, next, load]);

  const reload = useCallback(() => {
    gen.current++;
    busy.current = false;
    void load(null, true);
  }, [load]);

  return { items, setItems, loading, done, error, more, reload };
}

export function Sentinel({ onVisible, disabled }: { onVisible: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (disabled || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '800px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [disabled]);
  return <div ref={ref} className="sentinel" />;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span />
    </label>
  );
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Elitogram` : 'Elitogram';
  }, [title]);
}

// Remembered across the app: the user's choice to hear video sound.
const MUTE_KEY = 'eg.muted';
export function getMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) !== '0';
  } catch {
    return true;
  }
}
export function setMutedPref(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent('eg-muted', { detail: muted }));
}
export function useMuted(): [boolean, (v: boolean) => void] {
  const [muted, set] = useState(getMuted);
  useEffect(() => {
    const on = (e: Event) => set((e as CustomEvent).detail);
    window.addEventListener('eg-muted', on);
    return () => window.removeEventListener('eg-muted', on);
  }, []);
  return [muted, setMutedPref];
}
