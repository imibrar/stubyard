import busboy from 'busboy';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

export interface FormFile {
  stream: Readable;
  filename: string;
  mimeType: string;
  field: string;
}

/**
 * Streaming multipart/form-data: fields before the file are collected, the file part is handed to `onFile` as a
 * stream (never buffered), fields after it are returned too (S3 ignores them; other providers may not).
 * Resolves with the fields and onFile's result (null when the form has no file).
 */
export function parseForm<T>(
  body: Readable,
  headers: IncomingHttpHeaders,
  onFile: (fields: Record<string, string>, file: FormFile) => Promise<T>,
  opts: { fileField?: string; maxFieldBytes?: number } = {},
): Promise<{ fields: Record<string, string>; after: Record<string, string>; result: T | null }> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers, limits: { fieldSize: opts.maxFieldBytes ?? 1024 * 1024, files: 1 } });
    } catch (err) {
      return reject(err);
    }
    const fields: Record<string, string> = {};
    const after: Record<string, string> = {};
    let fileSeen = false;
    let pending: Promise<T> | null = null;
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      body.unpipe(bb);
      body.resume();
      reject(err);
    };
    bb.on('field', (name, value) => {
      if (fileSeen) after[name] = value;
      else if (!(name in fields)) fields[name] = value;
      // S3 is case-insensitive for policy form fields.
      const lower = name.toLowerCase();
      if (!fileSeen && !(lower in fields)) fields[lower] = value;
    });
    bb.on('file', (name, stream, info) => {
      if (fileSeen || (opts.fileField && name !== opts.fileField && name.toLowerCase() !== opts.fileField)) {
        stream.resume();
        return;
      }
      fileSeen = true;
      pending = onFile({ ...fields }, { stream, filename: info.filename ?? '', mimeType: info.mimeType, field: name });
      pending.catch((err) => {
        stream.resume();
        fail(err);
      });
    });
    bb.on('error', fail);
    bb.on('close', () => {
      if (failed) return;
      if (!pending) return resolve({ fields, after, result: null });
      pending.then((result) => resolve({ fields, after, result }), fail);
    });
    body.on('error', fail);
    body.pipe(bb);
  });
}
