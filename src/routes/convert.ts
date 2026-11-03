import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LEGACY_APP_ID, readDeviceId } from '../auth.js';
import { Errors } from '../errors.js';
import type { Caller, JobService } from '../jobService.js';
import type { Job } from '../jobStore.js';
import { receiveUpload } from '../upload.js';
import type { RouteContext } from './context.js';

export async function sendPdf(reply: FastifyReply, service: JobService, job: Job) {
  const path = await service.resultPathFor(job);
  return reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', 'attachment; filename="document.pdf"')
    .header('cache-control', 'no-store')
    .header('x-job-id', job.id)
    .header('x-page-count', job.pageCount === undefined ? '' : String(job.pageCount))
    .send(createReadStream(path));
}

async function convertAndWait(ctx: RouteContext, caller: Caller, request: FastifyRequest, reply: FastifyReply) {
  const upload = await receiveUpload(request, ctx.storage, ctx.config.limits.maxFileBytes);
  const job = await ctx.service.submit(caller, upload);
  const settled = await ctx.service.waitForCompletion(job.id, ctx.config.queue.syncWaitMs);
  if (settled.status === 'queued' || settled.status === 'processing') throw Errors.conversionTimeout();
  return sendPdf(reply, ctx.service, settled);
}

/** Synchronous endpoints: the response body is the PDF itself. */
export function registerConvertRoutes(app: FastifyInstance, ctx: RouteContext, requireKey: preHandlerAsyncHookHandler) {
  const config = { rateLimit: ctx.limits.deviceUpload };

  if (ctx.config.legacyEndpointEnabled) {
    // Contract of the previous backend, used by app builds that predate /v2: no key, field "file", PDF body.
    app.post('/convert_to_pdf', { config, preHandler: [ctx.limits.ipUpload] }, async (request, reply) =>
      convertAndWait(ctx, { appId: LEGACY_APP_ID, deviceId: readDeviceId(request) }, request, reply),
    );
  }

  app.post('/v2/convert', { config, preHandler: [ctx.limits.ipUpload, requireKey] }, async (request, reply) =>
    convertAndWait(ctx, { appId: request.appId, deviceId: request.deviceId }, request, reply),
  );
}
