import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

const SUBDIRS = ['in', 'out', 'tmp'] as const;

/**
 * Layout under DATA_DIR:
 *   in/<jobId>      uploaded source, deleted right after conversion
 *   out/<sha256>.pdf converted result, shared by jobs with identical input
 *   tmp/<uuid>      partial uploads and partial Gotenberg responses
 */
export class FileStorage {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await Promise.all(SUBDIRS.map((d) => mkdir(join(this.root, d), { recursive: true })));
  }

  incomingPath(jobId: string): string {
    return join(this.root, 'in', jobId);
  }

  resultPath(sha256: string): string {
    return join(this.root, 'out', `${sha256}.pdf`);
  }

  tmpPath(): string {
    return join(this.root, 'tmp', randomUUID());
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async size(path: string): Promise<number> {
    return (await stat(path)).size;
  }

  async touch(path: string): Promise<void> {
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** Deletes files older than `maxAgeMs`. Redis keys expire on their own; files on disk do not. */
  async sweep(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const dir of SUBDIRS) {
      const full = join(this.root, dir);
      const names = await readdir(full).catch(() => [] as string[]);
      for (const name of names) {
        const path = join(full, name);
        const info = await stat(path).catch(() => undefined);
        if (info && info.mtimeMs < cutoff) {
          await this.remove(path);
          removed++;
        }
      }
    }
    return removed;
  }
}
