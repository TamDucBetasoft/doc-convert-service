import { createWriteStream, openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { Errors } from './errors.js';

export interface PdfConverter {
  /** Converts `inputPath` to PDF at `outputPath`. `fileName` must carry the correct extension. */
  convert(inputPath: string, fileName: string, outputPath: string): Promise<void>;
  healthy(): Promise<boolean>;
}

/** Client for Gotenberg's LibreOffice route: https://gotenberg.dev/docs/routes#office-documents-into-pdfs-route */
export class GotenbergClient implements PdfConverter {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly retryAfterSeconds: number,
  ) {}

  async convert(inputPath: string, fileName: string, outputPath: string): Promise<void> {
    const form = new FormData();
    form.append('files', await openAsBlob(inputPath), fileName);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/forms/libreoffice/convert`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw Errors.conversionTimeout();
      }
      throw Errors.engineUnavailable(this.retryAfterSeconds);
    }

    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 503 || res.status === 429) throw Errors.engineUnavailable(this.retryAfterSeconds);
      if (res.status === 504) throw Errors.conversionTimeout();
      throw Errors.conversionFailed();
    }

    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(outputPath));
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }
}
