import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { PdfConverter } from '../src/gotenberg.js';
import { MemoryJobStore } from '../src/jobStore.js';
import { FileStorage } from '../src/storage.js';

export const PRINTER_KEY = 'printer-test-key-0123456789abcdef';
export const READER_KEY = 'reader-test-key-0123456789abcdef';

export class FakeConverter implements PdfConverter {
  calls = 0;
  pages = 2;
  failWith: Error | undefined;
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  hold() {
    this.gate = new Promise((resolve) => (this.openGate = resolve));
  }

  release() {
    this.openGate?.();
    this.gate = undefined;
  }

  async convert(_input: string, _fileName: string, outputPath: string) {
    this.calls++;
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    const doc = await PDFDocument.create();
    for (let i = 0; i < this.pages; i++) doc.addPage();
    await writeFile(outputPath, await doc.save());
  }

  async healthy() {
    return true;
  }
}

export async function createTestApp(env: Record<string, string> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pcs-app-'));
  const config: Config = loadConfig({
    API_KEYS: `printer:${PRINTER_KEY},pdfreader:${READER_KEY}`,
    DATA_DIR: dataDir,
    LOG_LEVEL: 'fatal',
    POLL_AFTER_MS: '50',
    ...env,
  });
  const store = new MemoryJobStore();
  const storage = new FileStorage(dataDir);
  await storage.init();
  const converter = new FakeConverter();
  const { app, service } = await buildApp({ config, store, storage, converter, logger: false });
  await app.ready();

  return {
    app,
    service,
    store,
    storage,
    converter,
    config,
    async close() {
      converter.release();
      await app.close();
      await service.queue.drain(5_000);
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function multipart(content: Buffer, filename: string, field = 'file') {
  const boundary = `----pcs${randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
