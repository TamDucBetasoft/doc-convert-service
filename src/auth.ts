import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from './errors.js';

export const LEGACY_APP_ID = 'legacy';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

declare module 'fastify' {
  interface FastifyRequest {
    appId: string;
    deviceId: string | undefined;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares digests so the comparison time does not depend on how many leading characters match. */
export function createKeyResolver(apiKeys: Map<string, string>) {
  const entries = [...apiKeys.entries()].map(([key, appId]) => ({ digest: digest(key), appId }));
  return (presented: string | undefined): string | undefined => {
    if (!presented) return undefined;
    const d = digest(presented);
    let match: string | undefined;
    for (const entry of entries) {
      if (timingSafeEqual(entry.digest, d)) match = entry.appId;
    }
    return match;
  };
}

export function readDeviceId(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-device-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && DEVICE_ID_PATTERN.test(value) ? value : undefined;
}

export function apiKeyGuard(resolve: (key: string | undefined) => string | undefined) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const raw = request.headers['x-api-key'];
    const appId = resolve(Array.isArray(raw) ? raw[0] : raw);
    if (!appId) throw Errors.unauthorized();
    request.appId = appId;
    request.deviceId = readDeviceId(request);
  };
}

/** Per-device rate-limit bucket; requests without a device id are limited by the IP ceiling alone. */
export function deviceRateLimitKey(request: FastifyRequest): string {
  const raw = request.headers['x-api-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  const keyPart = key ? digest(key).toString('hex').slice(0, 12) : 'anon';
  return `dev:${keyPart}:${readDeviceId(request) ?? 'none'}`;
}

export function lacksDeviceId(request: FastifyRequest): boolean {
  return readDeviceId(request) === undefined;
}
