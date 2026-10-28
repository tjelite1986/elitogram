import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { get } from '../api';
import { Avatar } from '../ui';

interface Suggestion {
  type: 'user' | 'creator';
  id: number;
  handle: string;
  name: string;
  avatar: string;
}

/** Textarea that suggests @mentions while typing. */
export function MentionInput({
  value,
  onChange,
  placeholder,
  rows = 4,
  onSubmit,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  onSubmit?: () => void;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!query) {
      setItems([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      get<{ items: Suggestion[] }>(`/api/mentions?q=${encodeURIComponent(query.q)}`, ctrl.signal)
        .then((r) => {
          setItems(r.items);
          setActive(0);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|[\s(])@([\w.-]{0,30})$/.exec(before);
    setQuery(m ? { q: m[2], start: caret - m[2].length - 1 } : null);
  };

  const pick = (s: Suggestion) => {
    if (!query || !ref.current) return;
    const caret = ref.current.selectionStart;
    const next = value.slice(0, query.start) + '@' + s.handle + ' ' + value.slice(caret);
    onChange(next);
    setQuery(null);
    const pos = query.start + s.handle.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (items.length && query) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setQuery(null);
        return;
      }
    }
    if (onSubmit && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel ?? placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query && items.length > 0 && (
        <div className="mention-list" role="listbox">
          {items.map((s, i) => (
            <button key={`${s.type}${s.id}`} type="button" className={i === active ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              <Avatar src={s.avatar} size={28} />
              <span>
                <b>{s.handle}</b> <span className="muted">{s.name !== s.handle ? s.name : ''}</span>
              </span>
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                {s.type}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
