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
    const cleanup = async () => {
      await Promise.all(files.map((f) => fsp.unlink(f.abs).catch(() => undefined)));
    };
    // Settles once: a request torn down mid-body may still let the parser close.
    let settled = false;
    const fail = async (err: Error) => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(err);
    };
    let bb: busboy.Busboy;
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
      if (settled) {
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
      writes.push(
        new Promise((res, rej) => {
          out.on('finish', res);
          out.on('close', res);
          out.on('error', rej);
          stream.on('error', rej);
        }),
      );
      stream.pipe(out);
    });
    bb.on('error', (err) => {
      void fail(err as Error);
    });
    bb.on('close', async () => {
      if (settled) return;
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
      if (settled) return;
      settled = true;
      resolve({ fields, files: files.filter((f) => f.size > 0), cleanup });
    });
    // The client went away (cancelled, or left the page) before the body ended.
    // The parser may never close then, so tear it down here: stop feeding it,
    // close every file being written and remove what was staged.
    const abort = async () => {
      if (settled) return;
      req.unpipe(bb);
      bb.removeAllListeners('file');
      for (const out of outs) out.destroy();
      await Promise.allSettled(writes);
      await fail(new Error('Upload aborted'));
    };
    req.on('aborted', () => void abort());
    req.on('close', () => {
      if (!req.complete) void abort();
    });
    req.pipe(bb);
  });
}
