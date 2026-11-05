import { afterEach, describe, expect, it } from 'vitest';
import { Errors } from '../src/errors.js';
import { VIETNAMESE_LINES, makeDocx, makeXlsx } from './fixtures/documents.js';
import { PRINTER_KEY, READER_KEY, createTestApp, multipart } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
let t: TestApp;

afterEach(async () => {
  t.converter.release();
  await t.close();
});

const DEVICE = 'device-aaaa-1111';

function auth(key = PRINTER_KEY, device = DEVICE) {
  return { 'x-api-key': key, 'x-device-id': device };
}

async function submit(content: Buffer, name: string, headers: Record<string, string> = auth()) {
  const body = multipart(content, name);
  return t.app.inject({ method: 'POST', url: '/v2/jobs', payload: body.payload, headers: { ...body.headers, ...headers } });
}

async function pollUntilSettled(jobId: string, headers = auth()) {
  for (let i = 0; i < 100; i++) {
    const res = await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}`, headers });
    const status = res.json().status;
    if (status === 'done' || status === 'failed') return res.json();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}

describe('auth', () => {
  it('rejects /v2 requests without a valid key', async () => {
    t = await createTestApp();
    const res = await submit(makeDocx(['x']), 'a.docx', { 'x-api-key': 'wrong-key-wrong-key-wrong-key' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthorized', message: expect.any(String) });
  });

  it('refuses API keys shorter than 24 characters at startup', async () => {
    await expect(createTestApp({ API_KEYS: 'printer:short' })).rejects.toThrow(/at least 24/);
    t = await createTestApp();
  });
});

describe('async jobs', () => {
  it('converts, reports progress and serves the PDF', async () => {
    t = await createTestApp();
    const res = await submit(makeDocx(VIETNAMESE_LINES), 'Hợp đồng.docx');
    expect(res.statusCode).toBe(202);
    const created = res.json();
    expect(created).toMatchObject({ status: 'queued', format: 'docx', pollAfterMs: 50 });
    expect(res.headers.location).toBe(`/v2/jobs/${created.jobId}`);

    const done = await pollUntilSettled(created.jobId);
    expect(done).toMatchObject({ status: 'done', pageCount: 2 });

    const pdf = await t.app.inject({ method: 'GET', url: `/v2/jobs/${created.jobId}/result`, headers: auth() });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['x-page-count']).toBe('2');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('does not store the original file name', async () => {
    t = await createTestApp();
    const res = await submit(makeDocx(['x']), 'Nguyen Van A - ly hon.docx');
    const job = await t.store.get(res.json().jobId);
    expect(JSON.stringify(job)).not.toContain('Nguyen');
  });

  it('answers identical content from cache without converting again', async () => {
    t = await createTestApp();
    const file = makeDocx(['cache me']);
    const first = await submit(file, 'a.docx');
    await pollUntilSettled(first.json().jobId);

    const second = await submit(file, 'renamed.docx', auth(PRINTER_KEY, 'device-bbbb-2222'));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'done', pageCount: 2 });
    expect(second.json().jobId).not.toBe(first.json().jobId);
    expect(t.converter.calls).toBe(1);
  });

  it('returns the same job for a repeated Idempotency-Key', async () => {
    t = await createTestApp();
    const headers = { ...auth(), 'idempotency-key': 'retry-key-123' };
    const a = await submit(makeDocx(['one']), 'a.docx', headers);
    const b = await submit(makeDocx(['one']), 'a.docx', headers);
    expect(b.json().jobId).toBe(a.json().jobId);
    expect(t.converter.calls).toBeLessThanOrEqual(1);
  });

  it('hides jobs from other apps and other devices', async () => {
    t = await createTestApp();
    const { jobId } = (await submit(makeDocx(['secret']), 'a.docx')).json();
    for (const headers of [auth(READER_KEY), auth(PRINTER_KEY, 'device-cccc-3333')]) {
      const res = await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}`, headers });
      expect(res.statusCode).toBe(404);
    }
  });

  it('returns 409 for a result that is not ready yet', async () => {
    t = await createTestApp();
    t.converter.hold();
    const { jobId } = (await submit(makeDocx(['slow']), 'a.docx')).json();
    const res = await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}/result`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('job_not_ready');
  });

  it('reports engine failures on the job and on the result endpoint', async () => {
    t = await createTestApp();
    t.converter.failWith = Errors.conversionFailed();
    const { jobId } = (await submit(makeXlsx({ Sheet1: [['a']] }), 'a.xlsx')).json();
    const settled = await pollUntilSettled(jobId);
    expect(settled).toMatchObject({ status: 'failed', error: { code: 'conversion_failed' } });

    const res = await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}/result`, headers: auth() });
    expect(res.statusCode).toBe(422);
  });

  it('answers 503 with Retry-After on the result of a job the engine could not take', async () => {
    t = await createTestApp();
    t.converter.failWith = Errors.engineUnavailable(5);
    const { jobId } = (await submit(makeXlsx({ Sheet1: [['b']] }), 'b.xlsx')).json();
    await pollUntilSettled(jobId);

    const res = await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}/result`, headers: auth() });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('engine_unavailable');
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('deletes job and result on DELETE', async () => {
    t = await createTestApp();
    const { jobId } = (await submit(makeDocx(['bye']), 'a.docx')).json();
    await pollUntilSettled(jobId);
    const del = await t.app.inject({ method: 'DELETE', url: `/v2/jobs/${jobId}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    const after = await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}`, headers: auth() });
    expect(after.statusCode).toBe(404);
  });

  it('rejects malformed job ids as not found', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/v2/jobs/../../etc/passwd', headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});

describe('validation and backpressure', () => {
  it('returns 415 for unsupported content', async () => {
    t = await createTestApp();
    const res = await submit(Buffer.from('just text, not a document'), 'a.docx');
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe('unsupported_format');
  });

  it('returns 413 when the file exceeds MAX_FILE_BYTES', async () => {
    t = await createTestApp({ MAX_FILE_BYTES: '1024' });
    const res = await submit(Buffer.alloc(4096, 1), 'big.docx');
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('file_too_large');
  });

  it('returns 400 when the "file" field is missing', async () => {
    t = await createTestApp();
    const body = multipart(makeDocx(['x']), 'a.docx', 'document');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v2/jobs',
      payload: body.payload,
      headers: { ...body.headers, ...auth() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('file_missing');
  });

  it('returns 503 with Retry-After when the queue is full', async () => {
    t = await createTestApp({ WORKER_CONCURRENCY: '1', QUEUE_MAX_PENDING: '1', RETRY_AFTER_SECONDS: '7' });
    t.converter.hold();
    expect((await submit(makeDocx(['1']), '1.docx')).statusCode).toBe(202);
    expect((await submit(makeDocx(['2']), '2.docx')).statusCode).toBe(202);
    const res = await submit(makeDocx(['3']), '3.docx');
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('queue_full');
    expect(res.headers['retry-after']).toBe('7');
  });

  it('rate-limits uploads per device', async () => {
    t = await createTestApp({ RATE_LIMIT_UPLOAD_MAX: '2' });
    await submit(makeDocx(['1']), '1.docx');
    await submit(makeDocx(['2']), '2.docx');
    const res = await submit(makeDocx(['3']), '3.docx');
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('per-IP ceiling', () => {
  const limits = { RATE_LIMIT_UPLOAD_MAX: '2', RATE_LIMIT_IP_UPLOAD_MAX: '3', RATE_LIMIT_IP_POLL_MAX: '50' };

  async function legacy(content: Buffer, remoteAddress = '127.0.0.1') {
    const body = multipart(content, 'old.docx');
    return t.app.inject({ method: 'POST', url: '/convert_to_pdf', payload: body.payload, headers: body.headers, remoteAddress });
  }

  it('stops a client that rotates device ids', async () => {
    t = await createTestApp(limits);
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await submit(makeDocx([`r${i}`]), 'a.docx', auth(PRINTER_KEY, `rotating-device-${i}`))).statusCode);
    }
    expect(codes).toEqual([202, 202, 202, 429]);
  });

  it('limits the legacy endpoint by IP only, above the per-device limit', async () => {
    t = await createTestApp(limits);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await legacy(makeDocx([`l${i}`]))).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('counts uploads across endpoints together and leaves other IPs alone', async () => {
    t = await createTestApp(limits);
    expect((await submit(makeDocx(['a']), 'a.docx')).statusCode).toBe(202);
    expect((await legacy(makeDocx(['b']))).statusCode).toBe(200);
    expect((await legacy(makeDocx(['c']))).statusCode).toBe(200);
    const blocked = await submit(makeDocx(['d']), 'd.docx', auth(PRINTER_KEY, 'fresh-device-0001'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('rate_limited');
    expect((await legacy(makeDocx(['e']), '10.1.2.3')).statusCode).toBe(200);
  });

  it('keeps polling available after the upload ceiling is reached', async () => {
    t = await createTestApp(limits);
    const { jobId } = (await submit(makeDocx(['p']), 'p.docx')).json();
    await legacy(makeDocx(['q']));
    await legacy(makeDocx(['r']));
    expect((await legacy(makeDocx(['s']))).statusCode).toBe(429);
    expect((await t.app.inject({ method: 'GET', url: `/v2/jobs/${jobId}`, headers: auth() })).statusCode).toBe(200);
  });
});

describe('synchronous endpoints', () => {
  it('keeps the legacy contract: no key, field "file", PDF body', async () => {
    t = await createTestApp();
    const body = multipart(makeDocx(VIETNAMESE_LINES), 'old-app.docx');
    const res = await t.app.inject({ method: 'POST', url: '/convert_to_pdf', payload: body.payload, headers: body.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('can switch the legacy endpoint off', async () => {
    t = await createTestApp({ LEGACY_ENDPOINT_ENABLED: 'false' });
    const body = multipart(makeDocx(['x']), 'a.docx');
    const res = await t.app.inject({ method: 'POST', url: '/convert_to_pdf', payload: body.payload, headers: body.headers });
    expect(res.statusCode).toBe(404);
  });

  it('serves /v2/convert with a key and a structured error on failure', async () => {
    t = await createTestApp();
    const body = multipart(makeDocx(['x']), 'a.docx');
    const ok = await t.app.inject({
      method: 'POST',
      url: '/v2/convert',
      payload: body.payload,
      headers: { ...body.headers, ...auth() },
    });
    expect(ok.statusCode).toBe(200);

    t.converter.failWith = Errors.conversionTimeout();
    const body2 = multipart(makeDocx(['y']), 'b.docx');
    const fail = await t.app.inject({
      method: 'POST',
      url: '/v2/convert',
      payload: body2.payload,
      headers: { ...body2.headers, ...auth() },
    });
    expect(fail.statusCode).toBe(504);
    expect(fail.json().code).toBe('conversion_timeout');
  });
});

describe('operations', () => {
  it('exposes health, readiness and metrics', async () => {
    t = await createTestApp({ METRICS_TOKEN: 'metrics-secret' });
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const ready = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { redis: true, gotenberg: true } });

    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const metrics = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret' },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('pcs_queue_depth');
  });

  it('re-queues interrupted jobs whose input survived a restart', async () => {
    t = await createTestApp();
    t.converter.hold();
    const { jobId } = (await submit(makeDocx(['restart']), 'a.docx')).json();
    const job = (await t.store.get(jobId))!;
    await t.store.save({ ...job, status: 'processing' });

    const orphan = { ...job, id: '00000000-0000-4000-8000-000000000000', status: 'queued' as const };
    await t.store.save(orphan);

    t.converter.release();
    const result = await t.service.recover();
    expect(result.failed).toBe(1);
    expect((await t.store.get(orphan.id))?.error?.code).toBe('interrupted');
  });
});
