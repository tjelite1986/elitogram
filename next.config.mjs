// Elitogram serves its own media end to end: photos, video posts, posters,
// avatars and banners all come from this app's own routes. The only cross-origin
// call the browser makes is to the sign-in host, and that is a redirect, not a
// fetch. 'unsafe-inline' script/style is required by Next's hydration payload
// and by Tailwind's injected styles; ws:/wss: by the /api/ws notification
// socket.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // No "output: standalone". A custom server (server.mjs) hosts the WebSocket
  // endpoint and the background-job scheduler alongside Next, and the
  // maintenance scripts run inside this container via `docker exec` and need
  // better-sqlite3 and sharp at runtime — Next only traces its own server, so
  // the image ships the full production node_modules instead.
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
