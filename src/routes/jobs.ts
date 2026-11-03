import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { Errors } from '../errors.js';
import type { Caller } from '../jobService.js';
import type { Job } from '../jobStore.js';
import { receiveUpload } from '../upload.js';
import type { RouteContext } from './context.js';
import { sendPdf } from './convert.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

type JobParams = { Params: { id: string } };

function view(job: Job, pollAfterMs: number) {
  return {
    jobId: job.id,
    status: job.status,
    format: job.format,
    sizeBytes: job.sizeBytes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    ...(job.status === 'queued' || job.status === 'processing' ? { pollAfterMs } : {}),
    ...(job.status === 'done' ? { pageCount: job.pageCount ?? null, resultBytes: job.resultBytes ?? null } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function caller(request: FastifyRequest): Caller {
  return { appId: request.appId, deviceId: request.deviceId };
}

function jobId(request: FastifyRequest<JobParams>): string {
  const id = request.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw Errors.jobNotFound();
  return id;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw Errors.badRequest('Idempotency-Key must be 8-128 chars of [A-Za-z0-9._:-]');
  }
  return value;
}

/** Asynchronous API: upload returns immediately with a job id; the client polls, then downloads. */
export function registerJobRoutes(app: FastifyInstance, ctx: RouteContext, requireKey: preHandlerAsyncHookHandler) {
  const { pollAfterMs } = ctx.config.queue;
  const upload = { rateLimit: { max: ctx.config.rateLimit.uploadMax, timeWindow: ctx.config.rateLimit.windowMs } };
  const poll = { rateLimit: { max: ctx.config.rateLimit.pollMax, timeWindow: ctx.config.rateLimit.windowMs } };

  app.post('/v2/jobs', { config: upload, preHandler: requireKey }, async (request, reply) => {
    const key = idempotencyKey(request);
    const file = await receiveUpload(request, ctx.storage, ctx.config.limits.maxFileBytes);
    const job = await ctx.service.submit(caller(request), file, key);
    return reply
      .code(job.status === 'done' ? 200 : 202)
      .header('location', `/v2/jobs/${job.id}`)
      .send(view(job, pollAfterMs));
  });

  app.get<JobParams>('/v2/jobs/:id', { config: poll, preHandler: requireKey }, async (request) =>
    view(await ctx.service.getForCaller(jobId(request), caller(request)), pollAfterMs),
  );

  app.get<JobParams>('/v2/jobs/:id/result', { config: poll, preHandler: requireKey }, async (request, reply) => {
    const job = await ctx.service.getForCaller(jobId(request), caller(request));
    return sendPdf(reply, ctx.service, job);
  });

  app.delete<JobParams>('/v2/jobs/:id', { config: poll, preHandler: requireKey }, async (request, reply) => {
    await ctx.service.delete(jobId(request), caller(request));
    return reply.code(204).send();
  });
}
