import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors.js';
import type { RouteContext } from './context.js';

const sha = (v: string) => createHash('sha256').update(v).digest();

export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext) {
  /** Liveness: the process is up. Restart the container only when this fails. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: dependencies answer. A load balancer stops routing here while this fails. */
  app.get('/readyz', async (_request, reply) => {
    const [redis, gotenberg] = await Promise.all([ctx.store.ping(), ctx.converter.healthy()]);
    const ready = redis && gotenberg;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { redis, gotenberg },
      queue: { depth: ctx.service.queue.depth, active: ctx.service.queue.active },
    });
  });

  app.get('/metrics', async (request, reply) => {
    if (ctx.config.metricsToken) {
      const header = request.headers.authorization ?? '';
      const expected = sha(`Bearer ${ctx.config.metricsToken}`);
      if (!timingSafeEqual(sha(header), expected)) throw Errors.unauthorized();
    }
    return reply.header('content-type', ctx.metrics.registry.contentType).send(await ctx.metrics.registry.metrics());
  });
}
