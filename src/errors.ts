export type ErrorCode =
  | 'unauthorized'
  | 'file_missing'
  | 'file_too_large'
  | 'unsupported_format'
  | 'archive_rejected'
  | 'conversion_failed'
  | 'conversion_timeout'
  | 'engine_unavailable'
  | 'queue_full'
  | 'rate_limited'
  | 'job_not_found'
  | 'job_not_ready'
  | 'result_expired'
  | 'interrupted'
  | 'bad_request'
  | 'not_found'
  | 'internal_error';

/** Error with a stable machine-readable `code`; clients branch on `code`, never on `message`. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export const Errors = {
  badRequest: (message: string) => new AppError(400, 'bad_request', message),
  unauthorized: () => new AppError(401, 'unauthorized', 'Missing or invalid API key'),
  fileMissing: () => new AppError(400, 'file_missing', 'Multipart field "file" is required'),
  fileTooLarge: (maxBytes: number) =>
    new AppError(413, 'file_too_large', `File exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`),
  unsupportedFormat: () =>
    new AppError(415, 'unsupported_format', 'Supported: doc, docx, xls, xlsx, ppt, pptx, odt, ods, odp, rtf'),
  archiveRejected: (reason: string) => new AppError(422, 'archive_rejected', `Document rejected: ${reason}`),
  conversionFailed: (detail = 'The document could not be converted') =>
    new AppError(422, 'conversion_failed', detail),
  conversionTimeout: () => new AppError(504, 'conversion_timeout', 'Conversion took too long'),
  engineUnavailable: (retryAfterSeconds: number) =>
    new AppError(503, 'engine_unavailable', 'Conversion engine unavailable, retry later', {
      'retry-after': String(retryAfterSeconds),
    }),
  queueFull: (retryAfterSeconds: number) =>
    new AppError(503, 'queue_full', 'Server is busy, retry later', { 'retry-after': String(retryAfterSeconds) }),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, 'rate_limited', 'Too many requests', { 'retry-after': String(retryAfterSeconds) }),
  jobNotFound: () => new AppError(404, 'job_not_found', 'Job not found'),
  jobNotReady: () => new AppError(409, 'job_not_ready', 'Job is still in progress'),
  resultExpired: () => new AppError(410, 'result_expired', 'Result has expired or was deleted'),
  interrupted: () => new AppError(503, 'interrupted', 'Job was interrupted by a server restart, please resubmit'),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
