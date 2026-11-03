import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { Errors } from './errors.js';
import type { Upload } from './jobService.js';
import type { FileStorage } from './storage.js';

/** Streams the multipart field "file" to disk while hashing it, so large uploads never sit in memory. */
export async function receiveUpload(request: FastifyRequest, storage: FileStorage, maxBytes: number): Promise<Upload> {
  const part = await request.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!part || part.fieldname !== 'file') {
    part?.file.resume();
    throw Errors.fileMissing();
  }

  const tmpPath = storage.tmpPath();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(part.file, meter, createWriteStream(tmpPath));
  } catch (e) {
    await storage.remove(tmpPath);
    if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw Errors.fileTooLarge(maxBytes);
    throw e;
  }

  if (part.file.truncated) {
    await storage.remove(tmpPath);
    throw Errors.fileTooLarge(maxBytes);
  }
  if (sizeBytes === 0) {
    await storage.remove(tmpPath);
    throw Errors.fileMissing();
  }

  return { tmpPath, sha256: hash.digest('hex'), sizeBytes, originalName: part.filename ?? '' };
}
