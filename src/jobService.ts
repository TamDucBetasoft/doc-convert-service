import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import type { Config } from './config.js';
import { AppError, Errors, isAppError } from './errors.js';
import { detectFormat, type ZipLimits } from './fileType.js';
import type { PdfConverter } from './gotenberg.js';
import type { Job, JobStore } from './jobStore.js';
import type { Metrics } from './metrics.js';
import { JobQueue } from './queue.js';
import type { FileStorage } from './storage.js';
import { prepareXlsx } from './xlsxPrep.js';

/**
 * Bump whenever the conversion pipeline changes what a given input produces, so results cached by an older
 * pipeline are not served for identical uploads.
 */
const CONVERSION_REVISION = 2;

function resultKey(sha256: string): string {
  return `${sha256}-r${CONVERSION_REVISION}`;
}

export type Upload = {
  tmpPath: string;
  sha256: string;
  sizeBytes: number;
  originalName: string;
};

export type Caller = { appId: string; deviceId: string | undefined };

type Deps = {
  config: Config;
  store: JobStore;
  storage: FileStorage;
  converter: PdfConverter;
  log: FastifyBaseLogger;
};

async function countPages(path: string): Promise<number | undefined> {
  try {
    const doc = await PDFDocument.load(await readFile(path), { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return undefined;
  }
}

export class JobService {
  readonly queue: JobQueue;
  private metrics!: Metrics;
  private readonly zipLimits: ZipLimits;

  constructor(private readonly deps: Deps) {
    const { queue } = deps.config;
    this.queue = new JobQueue(queue.concurrency, queue.maxPending, queue.retryAfterSeconds, (id) => this.process(id));
    this.zipLimits = {
      maxUncompressedBytes: deps.config.limits.zipMaxUncompressedBytes,
      maxEntries: deps.config.limits.zipMaxEntries,
      maxRatio: deps.config.limits.zipMaxRatio,
    };
  }

  attachMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  async submit(caller: Caller, upload: Upload, idempotencyKey?: string): Promise<Job> {
    const { store, storage } = this.deps;
    const id = randomUUID();
    let claimedKey = false;

    try {
      if (idempotencyKey) {
        const existingId = await store.claimIdempotencyKey(caller.appId, idempotencyKey, id);
        if (existingId) {
          const existing = await store.get(existingId);
          if (existing && this.isOwner(existing, caller)) {
            await storage.remove(upload.tmpPath);
            return existing;
          }
          await store.releaseIdempotencyKey(caller.appId, idempotencyKey);
          await store.claimIdempotencyKey(caller.appId, idempotencyKey, id);
        }
        claimedKey = true;
      }

      const format = await detectFormat(upload.tmpPath, upload.originalName, this.zipLimits);
      this.metrics.uploadBytes.observe(upload.sizeBytes);

      const now = new Date();
      const job: Job = {
        id,
        appId: caller.appId,
        deviceId: caller.deviceId,
        status: 'queued',
        format,
        sha256: upload.sha256,
        sizeBytes: upload.sizeBytes,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.deps.config.resultTtlSeconds * 1000).toISOString(),
      };

      const key = resultKey(upload.sha256);
      const cached = this.deps.config.cacheEnabled ? await store.getCachedResult(key) : null;
      const resultPath = storage.resultPath(key);
      if (cached && (await storage.exists(resultPath))) {
        await storage.remove(upload.tmpPath);
        // Refresh mtime so the disk sweeper keeps the shared result as long as this new job needs it.
        await storage.touch(resultPath);
        await store.setCachedResult(key, cached);
        const done: Job = { ...job, status: 'done', pageCount: cached.pageCount, resultBytes: cached.resultBytes };
        await store.save(done);
        this.metrics.cacheHits.inc({ app: caller.appId, format });
        return done;
      }

      await rename(upload.tmpPath, storage.incomingPath(id));
      await store.save(job);
      try {
        this.queue.enqueue(id);
      } catch (e) {
        await storage.remove(storage.incomingPath(id));
        await store.delete(id);
        throw e;
      }
      return job;
    } catch (e) {
      await storage.remove(upload.tmpPath);
      if (claimedKey && idempotencyKey) await store.releaseIdempotencyKey(caller.appId, idempotencyKey);
      if (isAppError(e)) this.metrics.rejections.inc({ app: caller.appId, code: e.code });
      throw e;
    }
  }

  /** Waits until the job settles or `timeoutMs` passes, then returns its latest state. */
  async waitForCompletion(id: string, timeoutMs: number): Promise<Job> {
    const settled = this.queue.waitFor(id, timeoutMs);
    const current = await this.deps.store.get(id);
    if (!current) throw Errors.jobNotFound();
    if (current.status === 'done' || current.status === 'failed') return current;
    await settled;
    return (await this.deps.store.get(id)) ?? current;
  }

  async getForCaller(id: string, caller: Caller): Promise<Job> {
    const job = await this.deps.store.get(id);
    if (!job || !this.isOwner(job, caller)) throw Errors.jobNotFound();
    return job;
  }

  /** Path of a finished job's PDF, or the error the client should receive instead. */
  async resultPathFor(job: Job): Promise<string> {
    if (job.status === 'queued' || job.status === 'processing') throw Errors.jobNotReady();
    if (job.status === 'failed') {
      const code = job.error?.code ?? 'conversion_failed';
      const message = job.error?.message ?? 'Conversion failed';
      if (code === 'conversion_timeout') throw new AppError(504, code, message);
      if (code === 'engine_unavailable' || code === 'interrupted') {
        throw new AppError(503, code, message, { 'retry-after': String(this.deps.config.queue.retryAfterSeconds) });
      }
      throw new AppError(422, code, message);
    }
    const path = this.deps.storage.resultPath(resultKey(job.sha256));
    if (!(await this.deps.storage.exists(path))) throw Errors.resultExpired();
    return path;
  }

  async delete(id: string, caller: Caller): Promise<void> {
    const job = await this.getForCaller(id, caller);
    const { store, storage } = this.deps;
    await store.delete(id);
    if (job.status === 'done') {
      await store.deleteCachedResult(resultKey(job.sha256));
      await storage.remove(storage.resultPath(resultKey(job.sha256)));
    }
  }

  /** Re-queues jobs that were in flight when the previous process stopped; fails those whose input is gone. */
  async recover(): Promise<{ requeued: number; failed: number }> {
    const { store, storage } = this.deps;
    let requeued = 0;
    let failed = 0;
    for (const job of await store.listUnfinished()) {
      const hasInput = await storage.exists(storage.incomingPath(job.id));
      if (hasInput) {
        try {
          await store.save({ ...job, status: 'queued', updatedAt: new Date().toISOString() });
          this.queue.enqueue(job.id);
          requeued++;
          continue;
        } catch {
          // Queue full during recovery: fall through and fail the job so the client resubmits.
        }
      }
      await this.fail(job, Errors.interrupted());
      await storage.remove(storage.incomingPath(job.id));
      failed++;
    }
    return { requeued, failed };
  }

  private isOwner(job: Job, caller: Caller): boolean {
    if (job.appId !== caller.appId) return false;
    return job.deviceId === undefined || job.deviceId === caller.deviceId;
  }

  private async fail(job: Job, error: AppError): Promise<void> {
    await this.deps.store.save({
      ...job,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: { code: error.code, message: error.message },
    });
  }

  private async process(id: string): Promise<void> {
    const { store, storage, converter, log } = this.deps;
    const job = await store.get(id);
    if (!job || job.status !== 'queued') return;

    const input = storage.incomingPath(id);
    const prepared = storage.tmpPath();
    const tmpOut = storage.tmpPath();
    const key = resultKey(job.sha256);
    const output = storage.resultPath(key);
    const started = performance.now();
    await store.save({ ...job, status: 'processing', updatedAt: new Date().toISOString() });

    try {
      const source = await this.prepare(job, input, prepared);
      await converter.convert(source, `document.${job.format}`, tmpOut);
      const pageCount = await countPages(tmpOut);
      await rename(tmpOut, output);
      const resultBytes = await storage.size(output);
      await store.setCachedResult(key, { pageCount, resultBytes });
      await store.save({ ...job, status: 'done', pageCount, resultBytes, updatedAt: new Date().toISOString() });
      this.metrics.conversions.inc({ app: job.appId, format: job.format, result: 'done' });
      log.info({ jobId: id, format: job.format, sizeBytes: job.sizeBytes, pageCount }, 'conversion done');
    } catch (e) {
      const error = isAppError(e) ? e : Errors.conversionFailed();
      if (!isAppError(e)) log.error({ jobId: id, err: e }, 'unexpected conversion error');
      else log.warn({ jobId: id, format: job.format, code: error.code }, 'conversion failed');
      await storage.remove(tmpOut);
      await this.fail(job, error);
      this.metrics.conversions.inc({ app: job.appId, format: job.format, result: error.code });
    } finally {
      this.metrics.duration.observe({ format: job.format }, (performance.now() - started) / 1000);
      await storage.remove(input);
      await storage.remove(prepared);
    }
  }

  /** Returns the file to send to the engine: a print-ready rewrite when one applies, otherwise the upload. */
  private async prepare(job: Job, input: string, prepared: string): Promise<string> {
    const { config, log } = this.deps;
    if (job.format !== 'xlsx' || !config.xlsxPrintFixes) return input;
    try {
      const result = await prepareXlsx(input, prepared, config.xlsxPrepMaxBytes);
      if (!result.changed) return input;
      log.info({ jobId: job.id, sheets: result.sheets }, 'xlsx prepared for printing');
      return prepared;
    } catch (err) {
      log.warn({ jobId: job.id, err }, 'xlsx preparation skipped');
      return input;
    }
  }
}
