import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import busboy from 'busboy';
import type { Request } from 'express';
import { APP_DIRS, mediaAbs } from './files.js';

export interface Uploaded {
  field: string;
  name: string;
  abs: string;
  size: number;
}

export interface ParsedUpload {
  fields: Record<string, string>;
  files: Uploaded[];
  cleanup: () => Promise<void>;
}

const MAX_FILE_BYTES = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;

/**
 * Streams a multipart body to disk inside the media root's temp folder, so the
 * later move into a creator folder is a cheap rename. No small default limit.
 */
export function parseUpload(req: Request): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const tmpDir = mediaAbs(APP_DIRS.tmp);
    const fields: Record<string, string> = {};
    const files: Uploaded[] = [];
    const writes: Promise<void>[] = [];
    const outs: fs.WriteStream[] = [];
    const closings: Promise<void>[] = [];
    const cleanup = async () => {
      await Promise.all(files.map((f) => fsp.unlink(f.abs).catch(() => undefined)));
    };
    // Settles once: a request torn down mid-body may still let the parser close.
    let settled = false;
    let tearing = false;
    let bb: busboy.Busboy;
    // One teardown for every failure (a parser error, a failed write, an oversized
    // file, the client going away): stop feeding the parser, close every file
    // being written, wait for the writers, then remove what was staged.
    const fail = async (err: Error) => {
      if (settled || tearing) return;
      tearing = true;
      req.unpipe(bb);
      bb.removeAllListeners('file');
      for (const out of outs) out.destroy();
      // Every writer has released its file before the staged paths are removed.
      await Promise.allSettled([...writes, ...closings]);
      settled = true;
      await cleanup();
      reject(err);
    };
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: 50, fields: 50, fieldSize: 64 * 1024 } });
    } catch (err) {
      reject(err);
      return;
    }
    let failed: Error | null = null;
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (field, stream, info) => {
      if (settled || tearing) {
        stream.resume();
        return;
      }
      const abs = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.upload`);
      const entry: Uploaded = { field, name: info.filename || 'file', abs, size: 0 };
      files.push(entry);
      const out = fs.createWriteStream(abs);
      outs.push(out);
      stream.on('data', (c: Buffer) => {
        entry.size += c.length;
      });
      stream.on('limit', () => {
        failed = new Error(`File ${info.filename} is larger than the upload limit`);
      });
      const closed = new Promise<void>((res) => out.once('close', () => res()));
      closings.push(closed);
      const written = new Promise<void>((res, rej) => {
        out.on('finish', res);
        out.on('close', res);
        out.on('error', rej);
        stream.on('error', rej);
      });
      // A failed writer starts the teardown at once (the parser may not close
      // while the request stays open); handled here, it is never unhandled.
      written.catch((err) => void fail(err as Error));
      writes.push(written);
      stream.pipe(out);
    });
    bb.on('error', (err) => {
      void fail(err as Error);
    });
    bb.on('close', async () => {
      if (settled || tearing) return;
      try {
        await Promise.all(writes);
      } catch (err) {
        await fail(err as Error);
        return;
      }
      if (failed) {
        await fail(failed);
        return;
      }
      if (settled || tearing) return;
      settled = true;
      resolve({ fields, files: files.filter((f) => f.size > 0), cleanup });
    });
    // The client went away (cancelled, or left the page) before the body ended.
    // The parser may never close then, so tear it down here: stop feeding it,
    // close every file being written and remove what was staged.
    const abort = () => fail(new Error('Upload aborted'));
    req.on('aborted', () => void abort());
    req.on('close', () => {
      if (!req.complete) void abort();
    });
    req.pipe(bb);
  });
}
