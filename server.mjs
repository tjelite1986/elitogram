import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { startScheduler } from "./lib/jobs-runtime.mjs";

const port = Number(process.env.PORT) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";

// The cookie elite-v2 mints, scoped to the parent domain so the browser sends
// it here too.
const SESSION_COOKIE = "elite_session";

// Who a socket belongs to is decided the same way every page decides it: by
// asking elite-v2. Verifying the JWT here instead would need its signing
// secret — which would then live in two apps — and would still accept a session
// that has been revoked, because the row proving it exists is over there.
const VERIFY_URL = process.env.ELITE_VERIFY_URL || "";
if (!VERIFY_URL) {
  console.warn(
    "[ws] ELITE_VERIFY_URL is not set; no socket can be authorised and live notifications are off."
  );
}

// Hosts allowed as WebSocket Origin. Browsers always send Origin on the WS
// handshake; a mismatch means a foreign page is riding the user's cookie
// (cross-site WebSocket hijacking).
const APP_URL = process.env.APP_URL || "";
const allowedOriginHost = (() => {
  try {
    return APP_URL ? new URL(APP_URL).host : null;
  } catch {
    return null;
  }
})();

async function userIdForToken(token) {
  if (!VERIFY_URL || !token) return null;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json();
    const id = body?.ok ? Number(body.user?.id) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (err) {
    console.error("[ws] could not reach elite-v2 to verify a session:", err);
    return null;
  }
}

// Registry of userId -> Set<WebSocket>. Shared with the Next route handlers
// (same process) via globalThis, so lib/notifications.ts can push to live
// sockets without a second connection or a message bus.
const clients = new Map();
globalThis.__wsClients = clients;

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => handle(req, res));

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== "/api/ws") {
      socket.destroy();
      return;
    }

    // Reject cross-site handshakes: a present Origin must match this host.
    // (Non-browser clients that omit Origin fall through to the session check.)
    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed Origin */
      }
      if (
        !originHost ||
        (originHost !== allowedOriginHost && originHost !== req.headers.host)
      ) {
        socket.destroy();
        return;
      }
    }

    const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
    const userId = await userIdForToken(token);
    if (!userId) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId).add(ws);

      // Nothing is read from this socket. It exists so the server can say "you
      // have a new notification"; a client that sends frames is ignored rather
      // than given a second, unaudited way in.
      ws.on("close", () => {
        const set = clients.get(userId);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) clients.delete(userId);
      });
      ws.on("error", () => {});
    });
  } catch {
    socket.destroy();
  }
});

// Heartbeat: dead TCP peers (a phone dropping off Wi-Fi) never fire "close" on
// their own, leaving the socket in `clients` forever. Terminating an
// unresponsive socket triggers the normal close cleanup.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket closing */
    }
  }
}, 30_000);

server.listen(port, hostname, () => {
  console.log(`> Ready on http://${hostname}:${port} (custom server + ws)`);
  // Start the background-job scheduler once the server is accepting requests
  // (the http-triggered jobs loop back to it).
  startScheduler();
});
