import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { GotenbergClient } from './gotenberg.js';
import { RedisJobStore } from './jobStore.js';
import { FileStorage } from './storage.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

async function main() {
  const config = loadConfig();
  if (process.env.NODE_ENV === 'production' && [...config.apiKeys.keys()].some((k) => k.includes('CHANGE_ME'))) {
    throw new Error('API_KEYS still contains the placeholder from .env.example');
  }
  if (config.apiKeys.size === 0) {
    console.warn('API_KEYS is empty: every /v2 request will be rejected with 401');
  }

  // No offline queue: commands would otherwise wait out reconnects, and when the hostname stops resolving each
  // attempt can take seconds (measured 26 s per upload and 15 s per /readyz during a Redis outage on GitHub runners).
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, enableOfflineQueue: false });
  redis.on('error', (err: Error) => console.error(`redis: ${err.message}`));
  await new Promise<void>((resolve) => redis.once('ready', () => resolve()));
  const storage = new FileStorage(config.dataDir);
  await storage.init();

  const store = new RedisJobStore(redis, config.resultTtlSeconds);
  const converter = new GotenbergClient(config.gotenbergUrl, config.gotenbergTimeoutMs, config.queue.retryAfterSeconds);
  const { app, service } = await buildApp({ config, store, storage, converter, redis });

  const recovered = await service.recover();
  if (recovered.requeued || recovered.failed) app.log.info(recovered, 'recovered unfinished jobs');

  // Results outlive their Redis keys by one extra TTL so a client that polled "done" just before expiry
  // can still download.
  const sweep = setInterval(() => {
    storage
      .sweep(config.resultTtlSeconds * 2 * 1000)
      .then((removed) => removed && app.log.info({ removed }, 'swept expired files'))
      .catch((err) => app.log.error({ err }, 'sweep failed'));
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    await app.close();
    const drained = await service.queue.drain(config.shutdownGraceMs);
    if (!drained) app.log.warn('queue not drained before grace period; unfinished jobs will be recovered on next start');
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
