import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.string().default('false'),

  API_KEYS: z.string().default(''),
  LEGACY_ENDPOINT_ENABLED: bool.default(true),
  METRICS_TOKEN: z.string().default(''),

  GOTENBERG_URL: z.string().min(1).default('http://gotenberg:3000'),
  GOTENBERG_TIMEOUT_MS: int(60_000),
  REDIS_URL: z.string().min(1).default('redis://redis:6379'),
  DATA_DIR: z.string().min(1).default('/data'),

  MAX_FILE_BYTES: int(20 * 1024 * 1024),
  ZIP_MAX_UNCOMPRESSED_BYTES: int(200 * 1024 * 1024),
  ZIP_MAX_ENTRIES: int(5_000),
  ZIP_MAX_RATIO: int(100),

  WORKER_CONCURRENCY: int(2),
  QUEUE_MAX_PENDING: int(50),
  SYNC_WAIT_MS: int(90_000),
  RESULT_TTL_SECONDS: int(3_600),
  CACHE_ENABLED: bool.default(true),
  XLSX_PRINT_FIXES: bool.default(true),
  XLSX_PREP_MAX_BYTES: int(64 * 1024 * 1024),
  POLL_AFTER_MS: int(1_000),
  RETRY_AFTER_SECONDS: int(10),

  RATE_LIMIT_UPLOAD_MAX: int(30),
  RATE_LIMIT_POLL_MAX: int(240),
  RATE_LIMIT_IP_UPLOAD_MAX: int(120),
  RATE_LIMIT_IP_POLL_MAX: int(600),
  RATE_LIMIT_WINDOW_MS: int(60_000),

  SHUTDOWN_GRACE_MS: int(25_000),
});

export type Config = {
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  trustProxy: boolean | string;
  /** API key → app id (e.g. "printer", "pdfreader"). */
  apiKeys: Map<string, string>;
  legacyEndpointEnabled: boolean;
  metricsToken: string;
  gotenbergUrl: string;
  gotenbergTimeoutMs: number;
  redisUrl: string;
  dataDir: string;
  limits: {
    maxFileBytes: number;
    zipMaxUncompressedBytes: number;
    zipMaxEntries: number;
    zipMaxRatio: number;
  };
  queue: {
    concurrency: number;
    maxPending: number;
    syncWaitMs: number;
    pollAfterMs: number;
    retryAfterSeconds: number;
  };
  resultTtlSeconds: number;
  /** Disable only for load tests, so identical uploads measure real conversion cost. */
  cacheEnabled: boolean;
  /** Rewrite .xlsx before conversion: fit sheets to page width, print cached formula values. */
  xlsxPrintFixes: boolean;
  xlsxPrepMaxBytes: number;
  rateLimit: {
    /** Per device (X-Device-Id); skipped for requests without one. */
    uploadMax: number;
    pollMax: number;
    /**
     * Per client IP, across all upload (or poll) endpoints together. Stops clients that rotate device ids, and is
     * the only limit for the legacy endpoint. Kept well above the per-device limit because carrier-grade NAT puts
     * many phones behind one IP.
     */
    ipUploadMax: number;
    ipPollMax: number;
    windowMs: number;
  };
  shutdownGraceMs: number;
};

export function parseApiKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = pair.indexOf(':');
    if (sep <= 0 || sep === pair.length - 1) {
      throw new Error(`API_KEYS entry must be "<appId>:<key>", got "${pair.slice(0, sep > 0 ? sep : 8)}…"`);
    }
    const appId = pair.slice(0, sep);
    const key = pair.slice(sep + 1);
    if (key.length < 24) {
      throw new Error(`API key for app "${appId}" must be at least 24 characters`);
    }
    keys.set(key, appId);
  }
  return keys;
}

function parseTrustProxy(raw: string): boolean | string {
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '') return false;
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    apiKeys: parseApiKeys(e.API_KEYS),
    legacyEndpointEnabled: e.LEGACY_ENDPOINT_ENABLED,
    metricsToken: e.METRICS_TOKEN,
    gotenbergUrl: e.GOTENBERG_URL.replace(/\/+$/, ''),
    gotenbergTimeoutMs: e.GOTENBERG_TIMEOUT_MS,
    redisUrl: e.REDIS_URL,
    dataDir: e.DATA_DIR,
    limits: {
      maxFileBytes: e.MAX_FILE_BYTES,
      zipMaxUncompressedBytes: e.ZIP_MAX_UNCOMPRESSED_BYTES,
      zipMaxEntries: e.ZIP_MAX_ENTRIES,
      zipMaxRatio: e.ZIP_MAX_RATIO,
    },
    queue: {
      concurrency: Math.max(1, e.WORKER_CONCURRENCY),
      maxPending: e.QUEUE_MAX_PENDING,
      syncWaitMs: e.SYNC_WAIT_MS,
      pollAfterMs: e.POLL_AFTER_MS,
      retryAfterSeconds: e.RETRY_AFTER_SECONDS,
    },
    resultTtlSeconds: Math.max(60, e.RESULT_TTL_SECONDS),
    cacheEnabled: e.CACHE_ENABLED,
    xlsxPrintFixes: e.XLSX_PRINT_FIXES,
    xlsxPrepMaxBytes: e.XLSX_PREP_MAX_BYTES,
    rateLimit: {
      uploadMax: e.RATE_LIMIT_UPLOAD_MAX,
      pollMax: e.RATE_LIMIT_POLL_MAX,
      ipUploadMax: e.RATE_LIMIT_IP_UPLOAD_MAX,
      ipPollMax: e.RATE_LIMIT_IP_POLL_MAX,
      windowMs: e.RATE_LIMIT_WINDOW_MS,
    },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
  };
}
