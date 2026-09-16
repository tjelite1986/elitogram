import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Format helpers shared by the uploader, the importer and the sync scripts:
// what counts as an image, what a file's extension is, and how to get a HEIF
// into something sharp can read.

const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heic",
  "heif",
]);

export function isSupportedImage(filename: string, mime: string): boolean {
  const ext = (path.extname(filename).slice(1) || "").toLowerCase();
  return IMAGE_EXTS.has(ext) || mime.startsWith("image/");
}

export function getExt(filename: string): string {
  return (path.extname(filename).slice(1) || "bin").toLowerCase();
}

// HEIC/HEIF (iPhone) — sharp's bundled libvips can't decode it, so these need
// converting via heif-convert before any sharp processing. Decided from the
// FILE BYTES, not the extension or mime: downloads are often mislabeled (
// gallery-dl writes Instagram JPEGs as .heic), and trusting the name either
// feeds heif-convert garbage it rejects or hands sharp a HEIF it can't decode.
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
]);

export function isHeifBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString("latin1", 4, 8) !== "ftyp") return false;
  return HEIF_BRANDS.has(buffer.toString("latin1", 8, 12));
}

// Convert a HEIC/HEIF buffer to a JPEG buffer using the libheif CLI. EXIF is
// preserved by heif-convert, so downstream date/metadata reads still work.
export function heicToJpeg(buffer: Buffer): Buffer {
  const tmpIn = path.join(os.tmpdir(), `${randomUUID()}.heic`);
  const tmpOut = path.join(os.tmpdir(), `${randomUUID()}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    execFileSync("heif-convert", ["-q", "92", tmpIn, tmpOut], {
      stdio: "ignore",
    });
    return fs.readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpOut]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}
