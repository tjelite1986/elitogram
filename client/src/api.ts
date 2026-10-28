export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function get<T = any>(url: string, signal?: AbortSignal): Promise<T> {
  return fetch(url, { credentials: 'same-origin', signal }).then((r) => handle<T>(r));
}

export function send<T = any>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then((r) => handle<T>(r));
}

export const post = <T = any>(url: string, body?: unknown) => send<T>('POST', url, body ?? {});
export const patch = <T = any>(url: string, body: unknown) => send<T>('PATCH', url, body);
export const del = <T = any>(url: string) => send<T>('DELETE', url);

/** Multipart upload with progress; no client-side size cap. */
export function upload<T = any>(url: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(xhr.status, body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(form);
  });
}

// --- Shared types -------------------------------------------------------------

export interface Author {
  type: 'creator' | 'user';
  id: number;
  handle: string;
  name: string;
  avatar: string;
  adult: boolean;
}

export interface Media {
  id: number;
  kind: 'image' | 'video';
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  url: string;
  thumb: string;
}

export interface Post {
  id: number;
  caption: string;
  created_at: number;
  source_url: string | null;
  adult: boolean;
  deleted: boolean;
  author: Author;
  media: Media[];
  like_count: number;
  comment_count: number;
  liked: boolean;
  can_edit?: boolean;
}

export interface Tile {
  id: number;
  media_id: number;
  kind: 'image' | 'video';
  thumb: string;
  count: number;
  has_video: boolean;
}

export interface Page<T> {
  items: T[];
  next: string | number | null;
}

export interface Me {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  permissions: string[];
  has_pin: boolean;
  bio: string;
  avatar: string;
  badges: { id: number; name: string; color: string }[];
}
