// A caption written by a grabbit import sidecar ends with "Source: <url>" —
// the link the clip or image was grabbed from. Posts still carry that grammar,
// so the regex outlived the shorts module it was written for: the feed strips
// the line before rendering and shows the host as a small credit instead.
//
// Kept in a module of its own because both a client component and the server
// importer need it, and neither should pull the other's dependencies in.
export const SOURCE_RE = /(?:^|\s)Source:\s*(https?:\/\/\S+)/i;

// "https://www.instagram.com/p/CX12ab/" → "instagram.com/p/CX12ab": enough of
// the link to recognise where a post came from, short enough for a meta line.
export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    return (u.host.replace(/^www\./, "") + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
}
