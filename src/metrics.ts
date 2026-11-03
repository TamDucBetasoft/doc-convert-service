import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics(queueStats: () => { depth: number; active: number }) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const conversions = new Counter({
    name: 'pcs_conversions_total',
    help: 'Finished conversions by app, source format and result',
    labelNames: ['app', 'format', 'result'] as const,
    registers: [registry],
  });

  const cacheHits = new Counter({
    name: 'pcs_cache_hits_total',
    help: 'Submissions answered from the result cache',
    labelNames: ['app', 'format'] as const,
    registers: [registry],
  });

  const rejections = new Counter({
    name: 'pcs_rejections_total',
    help: 'Submissions rejected before conversion, by error code',
    labelNames: ['app', 'code'] as const,
    registers: [registry],
  });

  const duration = new Histogram({
    name: 'pcs_conversion_duration_seconds',
    help: 'Time spent in the conversion engine',
    labelNames: ['format'] as const,
    buckets: [0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45, 60],
    registers: [registry],
  });

  const uploadBytes = new Histogram({
    name: 'pcs_upload_bytes',
    help: 'Accepted upload sizes',
    buckets: [64e3, 256e3, 1e6, 2e6, 5e6, 10e6, 20e6, 50e6],
    registers: [registry],
  });

  new Gauge({
    name: 'pcs_queue_depth',
    help: 'Jobs waiting for a worker',
    registers: [registry],
    collect() {
      this.set(queueStats().depth);
    },
  });

  new Gauge({
    name: 'pcs_queue_active',
    help: 'Jobs currently converting',
    registers: [registry],
    collect() {
      this.set(queueStats().active);
    },
  });

  return { registry, conversions, cacheHits, rejections, duration, uploadBytes };
}
