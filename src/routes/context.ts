import type { Config } from '../config.js';
import type { PdfConverter } from '../gotenberg.js';
import type { JobService } from '../jobService.js';
import type { JobStore } from '../jobStore.js';
import type { Metrics } from '../metrics.js';
import type { FileStorage } from '../storage.js';

export type RouteContext = {
  config: Config;
  service: JobService;
  store: JobStore;
  storage: FileStorage;
  converter: PdfConverter;
  metrics: Metrics;
};
