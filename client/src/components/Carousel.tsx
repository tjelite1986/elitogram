import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Media } from '../api';
import { Icon } from '../icons';
import { useMuted } from '../ui';

interface Props {
  media: Media[];
  /** "feed" uses resized images; "full" uses originals. */
  quality?: 'feed' | 'full';
  index?: number;
  onIndex?: (i: number) => void;
  onDoubleTap?: () => void;
  onOpen?: (i: number) => void;
  style?: CSSProperties;
  className?: string;
  showDots?: boolean;
  /** Native video controls; defaults to on for "full". */
  controls?: boolean;
  /** Blurred copy of the image behind it, so letterboxed media fills the frame. */
  fill?: boolean;
}

export function aspectFor(m: Media | undefined): number {
  if (!m?.width || !m?.height) return 1;
  // Same bounds as a phone feed: no taller than 4:5, no wider than 1.91:1.
  return Math.min(1.91, Math.max(0.8, m.width / m.height));
}

export function Carousel({ media, quality = 'feed', index, onIndex, onDoubleTap, onOpen, style, className, showDots = true, controls = quality === 'full', fill = false }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(index ?? 0);
  const [visible, setVisible] = useState(false);
  const [heart, setHeart] = useState(0);
  // Paused by a tap; cleared when the slide or the carousel's visibility changes.
  const [held, setHeld] = useState(false);
  const [muted, setMuted] = useMuted();
  const lastTap = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (index === undefined || !track.current) return;
    const w = track.current.clientWidth;
    if (Math.round(track.current.scrollLeft / w) !== index) track.current.scrollTo({ left: index * w, behavior: 'smooth' });
  }, [index]);

  useEffect(() => {
    if (!root.current) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.intersectionRatio >= 0.6), { threshold: [0, 0.6, 1] });
    io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => setHeld(false), [visible, current]);

  // Only the visible slide's video plays.
  useEffect(() => {
    track.current?.querySelectorAll('video').forEach((v, i) => {
      const slide = Number(v.dataset.slide ?? i);
      if (visible && slide === current && !held) void v.play().catch(() => undefined);
      else v.pause();
    });
  }, [visible, current, held]);

  const onScroll = () => {
    const t = track.current;
    if (!t) return;
    const i = Math.round(t.scrollLeft / t.clientWidth);
    if (i !== current) {
      setCurrent(i);
      onIndex?.(i);
    }
  };

  const go = (d: number) => {
    const t = track.current;
    if (!t) return;
    const i = Math.max(0, Math.min(media.length - 1, current + d));
    t.scrollTo({ left: i * t.clientWidth, behavior: 'smooth' });
  };

  const tap = (i: number) => {
    const now = Date.now();
    if (onDoubleTap && now - lastTap.current < 300) {
      lastTap.current = 0;
      setHeart((h) => h + 1);
      onDoubleTap();
      return;
    }
    lastTap.current = now;
    // Without native controls, a tap on a video is the only way to pause it.
    const single = onOpen ? () => onOpen(i) : media[i]?.kind === 'video' && !controls ? () => setHeld((h) => !h) : null;
    if (single) {
      const at = now;
      setTimeout(() => lastTap.current === at && single(), onDoubleTap ? 300 : 0);
    }
  };

  const hasVideo = media[current]?.kind === 'video';

  return (
    <div ref={root} className={`carousel${fill ? ' fill' : ''} ${className ?? ''}`} style={style}>
      <div ref={track} className="carousel-track" onScroll={onScroll}>
        {media.map((m, i) => (
          <div
            key={m.id}
            className="carousel-slide"
            onClick={() => tap(i)}
            style={fill ? ({ '--fill': `url("${m.thumb}?w=320")` } as CSSProperties) : undefined}
          >
            {m.kind === 'image' ? (
              <img
                src={quality === 'feed' ? `${m.thumb}?w=1080` : m.url}
                // Wide feeds outgrow the 1080 px thumb; let the browser take the original there.
                srcSet={quality === 'feed' && m.width && m.width > 1080 ? `${m.thumb}?w=1080 1080w, ${m.url} ${m.width}w` : undefined}
                sizes={quality === 'feed' ? '(min-width: 768px) calc(100vw - 280px), 100vw' : undefined}
                alt=""
                loading={i === 0 ? 'eager' : 'lazy'}
                draggable={false}
                width={m.width ?? undefined}
                height={m.height ?? undefined}
              />
            ) : (
              <video
                data-slide={i}
                src={m.url}
                poster={`${m.thumb}?w=1080`}
                muted={muted}
                loop
                playsInline
                preload={i === current ? 'metadata' : 'none'}
                controls={controls}
              />
            )}
          </div>
        ))}
      </div>
      {media.length > 1 && current > 0 && (
        <button className="carousel-nav prev" aria-label="Previous" onClick={() => go(-1)}>
          <Icon name="left" />
        </button>
      )}
      {media.length > 1 && current < media.length - 1 && (
        <button className="carousel-nav next" aria-label="Next" onClick={() => go(1)}>
          <Icon name="right" />
        </button>
      )}
      {hasVideo && !controls && (
        <button className="mute-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted(!muted)}>
          <Icon name={muted ? 'muted' : 'sound'} />
        </button>
      )}
      {held && hasVideo && (
        <div className="play-pop">
          <Icon name="play" />
        </div>
      )}
      {heart > 0 && (
        <div className="heart-pop" key={heart}>
          <Icon name="heart" />
        </div>
      )}
      {showDots && media.length > 1 && (
        <div className="dots" style={{ position: 'absolute', bottom: 8, left: 0, right: 0, paddingTop: 0 }}>
          {media.map((m, i) => (
            <i key={m.id} className={i === current ? 'on' : ''} style={{ background: i === current ? '#fff' : 'rgba(255,255,255,.45)' }} />
          ))}
        </div>
      )}
    </div>
  );
}
