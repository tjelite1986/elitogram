/* Elitogram service worker.
 *
 * Two jobs, both small on purpose:
 *  - being registered at all, which is half of what makes the app installable;
 *  - stale-while-revalidate for thumbnails and avatars, so Explore, a tag page
 *    and a profile grid redraw instantly on a revisit instead of re-fetching
 *    ~1.7 MB across ~38 requests every single time.
 *
 * It deliberately never touches video, and never the full-resolution display
 * file. Playback is Range requests against /api/posts/media/<id>, and a worker
 * that answers those wrongly breaks seeking in ways that look like corrupt
 * files — those requests go straight to the network, as if no worker existed.
 * Keeping the display files out also stops a handful of 1.2 MB originals from
 * evicting the several hundred thumbnails the cache exists for.
 */
const IMG_CACHE = "elitogram-img-v1";
const IMG_LIMIT = 600;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== IMG_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  )
);

function isCacheableImage(url) {
  // Derivatives only: ?size=thumb is the square grid crop, ?size=fit the
  // aspect-preserving tile. A media URL with no size is the display file.
  if (/^\/api\/posts\/media\/\d+$/.test(url.pathname)) {
    const size = url.searchParams.get("size");
    return size === "thumb" || size === "fit";
  }
  return (
    /^\/api\/profiles\/[^/]+\/avatar$/.test(url.pathname) ||
    /^\/icon-\d+\.png$/.test(url.pathname)
  );
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - IMG_LIMIT;
  for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // A Range request for an image is not something this cache can answer: a
  // 206 cannot be stored, and a stored 200 is not what the caller asked for.
  if (req.headers.has("range")) return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!isCacheableImage(url)) return;

  // Serve the cached copy instantly, but always refetch in the background and
  // update the cache — a regenerated thumbnail lives at the same URL, so a pure
  // cache-first worker would pin the old frame forever. The routes send an
  // ETag, so an unchanged image revalidates as a cheap 304.
  event.respondWith(
    (async () => {
      const cache = await caches.open(IMG_CACHE);
      const hit = await cache.match(req);
      const revalidate = fetch(req)
        .then((res) => {
          // A cached copy outlives the 18+ gate, so anything the route marks
          // as adult is passed through and never stored. Withdrawn access has
          // to mean withdrawn pixels.
          if (res.ok && res.status === 200 && !res.headers.has("x-adult-media")) {
            cache.put(req, res.clone());
            trimCache(cache);
          }
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(revalidate);
        return hit;
      }
      const res = await revalidate;
      if (res) return res;
      return new Response("", { status: 504 });
    })()
  );
});
