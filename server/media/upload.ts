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
    const cleanup = async () => {
      await Promise.all(files.map((f) => fsp.unlink(f.abs).catch(() => undefined)));
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
      const abs = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.upload`);
      const entry: Uploaded = { field, name: info.filename || 'file', abs, size: 0 };
      files.push(entry);
      const out = fs.createWriteStream(abs);
      stream.on('data', (c: Buffer) => {
        entry.size += c.length;
      });
      stream.on('limit', () => {
        failed = new Error(`File ${info.filename} is larger than the upload limit`);
      });
      writes.push(
        new Promise((res, rej) => {
          out.on('finish', res);
          out.on('error', rej);
          stream.on('error', rej);
        }),
      );
      stream.pipe(out);
    });
    bb.on('error', async (err) => {
      await cleanup();
      reject(err);
    });
    bb.on('close', async () => {
      try {
        await Promise.all(writes);
      } catch (err) {
        await cleanup();
        reject(err);
        return;
      }
      if (failed) {
        await cleanup();
        reject(failed);
        return;
      }
      resolve({ fields, files: files.filter((f) => f.size > 0), cleanup });
    });
    req.on('aborted', () => {
      failed = new Error('Upload aborted');
    });
    req.pipe(bb);
  });
}
