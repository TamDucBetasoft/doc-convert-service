import type { preHandlerAsyncHookHandler } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { Config } from '../config.js';
import type { PdfConverter } from '../gotenberg.js';
import type { JobService } from '../jobService.js';
import type { JobStore } from '../jobStore.js';
import type { Metrics } from '../metrics.js';
import type { FileStorage } from '../storage.js';

/** Two layers per route: a per-device limit (route config) and a per-IP ceiling shared by all routes of a kind. */
export type RouteLimits = {
  deviceUpload: RateLimitOptions;
  devicePoll: RateLimitOptions;
  ipUpload: preHandlerAsyncHookHandler;
  ipPoll: preHandlerAsyncHookHandler;
};

export type RouteContext = {
  config: Config;
  service: JobService;
  store: JobStore;
  storage: FileStorage;
  converter: PdfConverter;
  metrics: Metrics;
  limits: RouteLimits;
};
