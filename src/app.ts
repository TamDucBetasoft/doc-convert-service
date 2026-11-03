import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type preHandlerAsyncHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import { apiKeyGuard, createKeyResolver, deviceRateLimitKey, lacksDeviceId } from './auth.js';
import type { Config } from './config.js';
import { AppError, Errors, isAppError } from './errors.js';
import type { PdfConverter } from './gotenberg.js';
import { JobService } from './jobService.js';
import type { JobStore } from './jobStore.js';
import { createMetrics } from './metrics.js';
import type { RouteLimits } from './routes/context.js';
import { registerConvertRoutes } from './routes/convert.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import type { FileStorage } from './storage.js';

export type AppDeps = {
  config: Config;
  store: JobStore;
  storage: FileStorage;
  converter: PdfConverter;
  /** Shared rate-limit counters across instances; omitted in tests (in-memory counters). */
  redis?: Redis;
  logger?: boolean | FastifyBaseLogger;
};

const MULTIPART_ERRORS_AS_TOO_LARGE = new Set(['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT']);

export async function buildApp(deps: AppDeps) {
  const { config } = deps;

  const app = Fastify({
    trustProxy: config.trustProxy,
    logger:
      deps.logger === undefined
        ? {
            level: config.logLevel,
            redact: ['req.headers["x-api-key"]', 'req.headers.authorization'],
          }
        : deps.logger,
  });

  const service = new JobService({
    config,
    store: deps.store,
    storage: deps.storage,
    converter: deps.converter,
    log: app.log,
  });
  const metrics = createMetrics(() => ({ depth: service.queue.depth, active: service.queue.active }));
  service.attachMetrics(metrics);

  app.decorateRequest('appId', '');
  app.decorateRequest('deviceId', undefined);

  await app.register(multipart, {
    limits: { fileSize: config.limits.maxFileBytes, files: 1, fields: 10, parts: 11, headerPairs: 200 },
  });

  await app.register(rateLimit, {
    global: false,
    redis: deps.redis,
    nameSpace: 'pcs:rl:',
    keyGenerator: deviceRateLimitKey,
    errorResponseBuilder: (_request, context) => Errors.rateLimited(Math.max(1, Math.ceil(context.ttl / 1000))),
  });

  // The plugin's own hooks run at most one limiter per request (it marks the request after the first), so the
  // per-device route limit would silence app.rateLimit(). createRateLimit() only counts, letting both layers apply.
  const ipCeiling = (prefix: string, max: number): preHandlerAsyncHookHandler => {
    const check = app.createRateLimit({ max, timeWindow: config.rateLimit.windowMs, keyGenerator: (req) => `${prefix}:${req.ip}` });
    return async (request) => {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) throw Errors.rateLimited(Math.max(1, result.ttlInSeconds));
    };
  };

  const { rateLimit: rl } = config;
  const limits: RouteLimits = {
    deviceUpload: { max: rl.uploadMax, timeWindow: rl.windowMs, allowList: lacksDeviceId },
    devicePoll: { max: rl.pollMax, timeWindow: rl.windowMs, allowList: lacksDeviceId },
    ipUpload: ipCeiling('ip-up', rl.ipUploadMax),
    ipPoll: ipCeiling('ip-poll', rl.ipPollMax),
  };

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    let error: AppError | undefined = isAppError(err) ? err : undefined;
    if (!error && MULTIPART_ERRORS_AS_TOO_LARGE.has(err.code)) error = Errors.fileTooLarge(config.limits.maxFileBytes);
    if (!error && err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') error = Errors.fileMissing();

    if (error) {
      if (error.statusCode >= 500) request.log.warn({ code: error.code }, error.message);
      return reply.code(error.statusCode).headers(error.headers).send(error.toJSON());
    }

    const status = (err as FastifyError).statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ code: 'bad_request', message: err.message });

    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal_error', message: 'Internal server error' });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'not_found', message: 'Route not found' }));

  const ctx = { config, service, store: deps.store, storage: deps.storage, converter: deps.converter, metrics, limits };
  const requireKey = apiKeyGuard(createKeyResolver(config.apiKeys));

  registerHealthRoutes(app, ctx);
  registerConvertRoutes(app, ctx, requireKey);
  registerJobRoutes(app, ctx, requireKey);

  return { app, service, metrics };
}
