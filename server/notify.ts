import webpush from 'web-push';
import { db, now, getSetting, setSetting } from './db/index.js';
import { config } from './config.js';

let vapid: { publicKey: string; privateKey: string } | null = null;

/** VAPID keys come from the environment; without them a pair is generated once and kept in the database. */
export function initPush(): void {
  let pub = config.vapidPublic;
  let priv = config.vapidPrivate;
  if (!pub || !priv) {
    pub = getSetting('vapid_public') ?? '';
    priv = getSetting('vapid_private') ?? '';
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      setSetting('vapid_public', pub);
      setSetting('vapid_private', priv);
    }
  }
  webpush.setVapidDetails(config.vapidSubject, pub, priv);
  vapid = { publicKey: pub, privateKey: priv };
}

export const vapidPublicKey = (): string => vapid?.publicKey ?? '';

export interface NotifyInput {
  userId: number;
  kind: 'like' | 'comment' | 'mention' | 'follow' | 'new_posts' | 'story' | 'system';
  text: string;
  actorId?: number | null;
  postId?: number | null;
  creatorId?: number | null;
  url?: string;
}

export function notify(n: NotifyInput): void {
  if (n.actorId && n.actorId === n.userId) return;
  db.prepare('INSERT INTO notifications (user_id, kind, actor_id, post_id, creator_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    n.userId,
    n.kind,
    n.actorId ?? null,
    n.postId ?? null,
    n.creatorId ?? null,
    n.text,
    now(),
  );
  void push(n.userId, { title: 'Elitogram', body: n.text, url: n.url ?? (n.postId ? `/p/${n.postId}` : '/notifications') });
}

async function push(userId: number, payload: { title: string; body: string; url: string }): Promise<void> {
  if (!vapid) return;
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as any[];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
    } catch (err: any) {
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else console.error(`Web push failed: ${err.message}`);
    }
  }
}

export function notifyFollowers(creatorId: number, postId: number, actorId: number | null): void {
  const c = db.prepare('SELECT handle, display_name FROM creators WHERE id = ?').get(creatorId) as any;
  const followers = db.prepare('SELECT user_id FROM follows WHERE creator_id = ?').pluck().all(creatorId) as number[];
  for (const uid of followers) notify({ userId: uid, kind: 'new_posts', actorId, postId, creatorId, text: `New post from ${c.display_name || c.handle}` });
}
