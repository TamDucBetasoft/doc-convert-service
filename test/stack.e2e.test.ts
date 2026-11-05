import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeDocx } from './fixtures/documents.js';

/**
 * Runs against a live `docker compose` stack and stops containers on purpose:
 * STACK_URL=http://localhost:8080 STACK_API_KEY=... STACK_COMPOSE="docker compose" npm test -- test/stack.e2e.test.ts
 */
const BASE = process.env.STACK_URL;
const KEY = process.env.STACK_API_KEY ?? '';
const COMPOSE = process.env.STACK_COMPOSE ?? 'docker compose';

const compose = (args: string) => execSync(`${COMPOSE} ${args}`, { stdio: 'pipe', timeout: 90_000 }).toString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uniqueDoc = () => makeDocx([`Tài liệu ${randomUUID()}`]);

type JobBody = {
  jobId: string;
  status: string;
  pollAfterMs?: number;
  pageCount?: number;
  error?: { code: string };
};

function form(doc: Buffer, name = 'document.docx') {
  const data = new FormData();
  data.append('file', new Blob([new Uint8Array(doc)]), name);
  return data;
}

function headers(deviceId: string, extra: Record<string, string> = {}) {
  return { 'x-api-key': KEY, 'x-device-id': deviceId, ...extra };
}

async function upload(doc: Buffer, deviceId: string, extra: Record<string, string> = {}) {
  return fetch(`${BASE}/v2/jobs`, { method: 'POST', headers: headers(deviceId, extra), body: form(doc) });
}

async function submit(doc: Buffer, deviceId: string): Promise<JobBody> {
  const res = await upload(doc, deviceId);
  expect([200, 202]).toContain(res.status);
  return (await res.json()) as JobBody;
}

async function getJob(id: string, deviceId: string): Promise<JobBody> {
  const res = await fetch(`${BASE}/v2/jobs/${id}`, { headers: headers(deviceId) });
  expect(res.status).toBe(200);
  return (await res.json()) as JobBody;
}

async function settle(id: string, deviceId: string, timeoutMs = 60_000): Promise<JobBody> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(id, deviceId);
    if (job.status === 'done' || job.status === 'failed') return job;
    await sleep(200);
  }
  throw new Error(`job ${id} did not settle within ${timeoutMs} ms`);
}

async function waitForReadiness(ready: boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/readyz`).catch(() => undefined);
    if (res) {
      await res.body?.cancel();
      if (res.ok === ready) return;
    }
    await sleep(500);
  }
  throw new Error(`/readyz did not become ${ready ? 'ready' : 'not ready'}`);
}

describe.skipIf(!BASE)('Docker stack', { timeout: 180_000 }, () => {
  afterAll(async () => {
    compose('start gotenberg redis gateway');
    compose('exec -T redis redis-cli config set maxmemory 256mb');
    await waitForReadiness(true);
  });

  it('runs the async job flow against real Redis and Gotenberg', async () => {
    const device = randomUUID();
    const doc = uniqueDoc();

    const created = await upload(doc, device, { 'idempotency-key': randomUUID() });
    expect(created.status).toBe(202);
    const job = (await created.json()) as JobBody;
    expect(job.pollAfterMs).toBeGreaterThan(0);

    const done = await settle(job.jobId, device);
    expect(done.status).toBe('done');
    expect(done.pageCount).toBeGreaterThanOrEqual(1);

    const result = await fetch(`${BASE}/v2/jobs/${job.jobId}/result`, { headers: headers(device) });
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const stranger = await fetch(`${BASE}/v2/jobs/${job.jobId}`, { headers: headers(randomUUID()) });
    expect(stranger.status).toBe(404);

    const removed = await fetch(`${BASE}/v2/jobs/${job.jobId}`, { method: 'DELETE', headers: headers(device) });
    expect(removed.ok).toBe(true);
    const gone = await fetch(`${BASE}/v2/jobs/${job.jobId}`, { headers: headers(device) });
    expect(gone.status).toBe(404);
  });

  it.each(['doc', 'xls'])('converts a legacy .%s and fails quickly when it is password-protected', async (ext) => {
    const device = randomUUID();
    const send = async (name: string) => {
      const data = form(await readFile(join(import.meta.dirname, 'fixtures', name)), name);
      const res = await fetch(`${BASE}/v2/jobs`, { method: 'POST', headers: headers(device), body: data });
      return settle(((await res.json()) as JobBody).jobId, device, 20_000);
    };

    expect((await send(`plain.${ext}`)).status).toBe('done');

    const locked = await send(`locked.${ext}`);
    expect(locked.error?.code).toBe('conversion_failed');
    const result = await fetch(`${BASE}/v2/jobs/${locked.jobId}/result`, { headers: headers(device) });
    expect(result.status).toBe(422);
    await result.body?.cancel();
  });

  it('returns the same job for a repeated Idempotency-Key', async () => {
    const device = randomUUID();
    const key = randomUUID();
    const first = (await (await upload(uniqueDoc(), device, { 'idempotency-key': key })).json()) as JobBody;
    const second = (await (await upload(uniqueDoc(), device, { 'idempotency-key': key })).json()) as JobBody;
    expect(second.jobId).toBe(first.jobId);
    await settle(first.jobId, device);
  });

  it('keeps per-device rate limit counters in Redis across a gateway restart', async () => {
    const device = randomUUID();
    const doc = uniqueDoc();
    await settle((await submit(doc, device)).jobId, device);
    for (let i = 1; i < 30; i++) {
      const res = await upload(doc, device);
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }

    const limited = await upload(doc, device);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(((await limited.json()) as { code: string }).code).toBe('rate_limited');

    compose('restart gateway');
    await waitForReadiness(true);

    const stillLimited = await upload(doc, device);
    expect(stillLimited.status).toBe(429);
    await stillLimited.body?.cancel();

    const other = await upload(doc, randomUUID());
    expect(other.ok).toBe(true);
    await other.body?.cancel();
  });

  it('finishes unfinished jobs after the gateway is killed', async () => {
    const device = randomUUID();
    const jobs = await Promise.all(Array.from({ length: 16 }, () => submit(uniqueDoc(), device)));

    compose('kill gateway');
    compose('start gateway');
    await waitForReadiness(true);

    const settled = await Promise.all(jobs.map((job) => settle(job.jobId, device)));
    expect(settled.map((job) => job.status)).toEqual(jobs.map(() => 'done'));
    expect(compose('logs gateway')).toContain('recovered unfinished jobs');
  });

  it('reports the engine as unavailable while Gotenberg is down and recovers afterwards', async () => {
    const device = randomUUID();
    const inFlight = await Promise.all(Array.from({ length: 6 }, () => submit(uniqueDoc(), device)));

    compose('kill gotenberg');
    const doc = uniqueDoc();
    try {
      await waitForReadiness(false);

      const outcomes = await Promise.all(inFlight.map((job) => settle(job.jobId, device)));
      for (const job of outcomes) {
        if (job.status === 'failed') expect(job.error?.code).toBe('engine_unavailable');
      }

      const failed = await settle((await submit(doc, device)).jobId, device);
      expect(failed.error?.code).toBe('engine_unavailable');

      const result = await fetch(`${BASE}/v2/jobs/${failed.jobId}/result`, { headers: headers(device) });
      expect(result.status).toBe(503);
      expect(result.headers.get('retry-after')).toBeTruthy();
      await result.body?.cancel();

      const sync = await fetch(`${BASE}/v2/convert`, { method: 'POST', headers: headers(device), body: form(uniqueDoc()) });
      expect(sync.status).toBe(503);
      expect(sync.headers.get('retry-after')).toBeTruthy();
      await sync.body?.cancel();

      const legacy = await fetch(`${BASE}/convert_to_pdf`, { method: 'POST', body: form(uniqueDoc()) });
      expect(legacy.status).toBe(503);
      await legacy.body?.cancel();
    } finally {
      compose('start gotenberg');
      await waitForReadiness(true);
    }

    const retried = await settle((await submit(doc, device)).jobId, device);
    expect(retried.status).toBe('done');
  });

  it('answers with a structured error while Redis refuses writes and recovers afterwards', async () => {
    const device = randomUUID();
    compose('exec -T redis redis-cli config set maxmemory 1');
    try {
      const res = await upload(uniqueDoc(), device);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(((await res.json()) as { code?: string }).code).toBeTruthy();
      expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    } finally {
      compose('exec -T redis redis-cli config set maxmemory 256mb');
    }
    const job = await settle((await submit(uniqueDoc(), device)).jobId, device);
    expect(job.status).toBe('done');
  });

  it('fails fast while Redis is down and recovers afterwards', async () => {
    const device = randomUUID();
    compose('stop redis');
    try {
      await waitForReadiness(false);

      const started = Date.now();
      const res = await upload(uniqueDoc(), device);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(Date.now() - started).toBeLessThan(5_000);
      await res.body?.cancel();

      const readinessStarted = Date.now();
      const readiness = await fetch(`${BASE}/readyz`);
      expect(readiness.status).toBe(503);
      expect(Date.now() - readinessStarted).toBeLessThan(5_000);
      await readiness.body?.cancel();
    } finally {
      compose('start redis');
      await waitForReadiness(true);
    }
    const job = await settle((await submit(uniqueDoc(), device)).jobId, device);
    expect(job.status).toBe('done');
  });
});
