import type { Redis } from 'ioredis';
import type { ErrorCode } from './errors.js';
import type { DocFormat } from './fileType.js';

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

/** File names are deliberately not stored: they often contain personal data. */
export type Job = {
  id: string;
  appId: string;
  deviceId?: string;
  status: JobStatus;
  format: DocFormat;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  pageCount?: number;
  resultBytes?: number;
  error?: { code: ErrorCode; message: string };
};

export type CachedResult = { pageCount?: number; resultBytes: number };

export interface JobStore {
  save(job: Job): Promise<void>;
  get(id: string): Promise<Job | null>;
  delete(id: string): Promise<void>;
  getCachedResult(sha256: string): Promise<CachedResult | null>;
  setCachedResult(sha256: string, result: CachedResult): Promise<void>;
  deleteCachedResult(sha256: string): Promise<void>;
  /** Returns the job id already bound to this key, or null when this call claimed the key for `jobId`. */
  claimIdempotencyKey(appId: string, key: string, jobId: string): Promise<string | null>;
  releaseIdempotencyKey(appId: string, key: string): Promise<void>;
  listUnfinished(): Promise<Job[]>;
  ping(): Promise<boolean>;
}

const isUnfinished = (s: JobStatus) => s === 'queued' || s === 'processing';

export class RedisJobStore implements JobStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly prefix = 'pcs:',
  ) {}

  private jobKey(id: string) {
    return `${this.prefix}job:${id}`;
  }
  private cacheKey(sha: string) {
    return `${this.prefix}cache:${sha}`;
  }
  private idemKey(appId: string, key: string) {
    return `${this.prefix}idem:${appId}:${key}`;
  }
  private get activeKey() {
    return `${this.prefix}jobs:active`;
  }

  async save(job: Job): Promise<void> {
    const tx = this.redis.multi().set(this.jobKey(job.id), JSON.stringify(job), 'EX', this.ttlSeconds);
    if (isUnfinished(job.status)) tx.sadd(this.activeKey, job.id);
    else tx.srem(this.activeKey, job.id);
    await tx.exec();
  }

  async get(id: string): Promise<Job | null> {
    const raw = await this.redis.get(this.jobKey(id));
    return raw ? (JSON.parse(raw) as Job) : null;
  }

  async delete(id: string): Promise<void> {
    await this.redis.multi().del(this.jobKey(id)).srem(this.activeKey, id).exec();
  }

  async getCachedResult(sha256: string): Promise<CachedResult | null> {
    const raw = await this.redis.get(this.cacheKey(sha256));
    return raw ? (JSON.parse(raw) as CachedResult) : null;
  }

  async setCachedResult(sha256: string, result: CachedResult): Promise<void> {
    await this.redis.set(this.cacheKey(sha256), JSON.stringify(result), 'EX', this.ttlSeconds);
  }

  async deleteCachedResult(sha256: string): Promise<void> {
    await this.redis.del(this.cacheKey(sha256));
  }

  async claimIdempotencyKey(appId: string, key: string, jobId: string): Promise<string | null> {
    const k = this.idemKey(appId, key);
    const ok = await this.redis.set(k, jobId, 'EX', this.ttlSeconds, 'NX');
    return ok ? null : await this.redis.get(k);
  }

  async releaseIdempotencyKey(appId: string, key: string): Promise<void> {
    await this.redis.del(this.idemKey(appId, key));
  }

  async listUnfinished(): Promise<Job[]> {
    const ids = await this.redis.smembers(this.activeKey);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.jobKey(id)));
    const jobs: Job[] = [];
    const stale: string[] = [];
    raws.forEach((raw, i) => {
      if (raw) jobs.push(JSON.parse(raw) as Job);
      else stale.push(ids[i]!);
    });
    if (stale.length) await this.redis.srem(this.activeKey, ...stale);
    return jobs.filter((j) => isUnfinished(j.status));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

/** In-process store for tests and local experiments; TTLs are not enforced. */
export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, Job>();
  readonly cache = new Map<string, CachedResult>();
  readonly idem = new Map<string, string>();

  async save(job: Job) {
    this.jobs.set(job.id, structuredClone(job));
  }
  async get(id: string) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }
  async delete(id: string) {
    this.jobs.delete(id);
  }
  async getCachedResult(sha: string) {
    return this.cache.get(sha) ?? null;
  }
  async setCachedResult(sha: string, r: CachedResult) {
    this.cache.set(sha, r);
  }
  async deleteCachedResult(sha: string) {
    this.cache.delete(sha);
  }
  async claimIdempotencyKey(appId: string, key: string, jobId: string) {
    const k = `${appId}:${key}`;
    const existing = this.idem.get(k);
    if (existing) return existing;
    this.idem.set(k, jobId);
    return null;
  }
  async releaseIdempotencyKey(appId: string, key: string) {
    this.idem.delete(`${appId}:${key}`);
  }
  async listUnfinished() {
    return [...this.jobs.values()].filter((j) => isUnfinished(j.status));
  }
  async ping() {
    return true;
  }
}
