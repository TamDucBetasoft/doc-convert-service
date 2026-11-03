import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import yauzl from 'yauzl';
import { Errors } from './errors.js';

export const DOC_FORMATS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

export type ZipLimits = {
  maxUncompressedBytes: number;
  maxEntries: number;
  maxRatio: number;
};

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const RTF_MAGIC = Buffer.from('{\\rtf', 'latin1');

const OLE2_FORMATS = new Set<DocFormat>(['doc', 'xls', 'ppt']);

const ODF_MIMETYPES: Record<string, DocFormat> = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

/** Only compressed entries above this size are checked against `maxRatio`; tiny XML parts compress extremely well. */
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

function extensionOf(fileName: string): string {
  return extname(fileName).slice(1).toLowerCase();
}

async function readHead(path: string, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

type ZipInspection = { names: string[]; odfMimetype?: string };

function readSmallEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('cannot open zip entry'));
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > max) {
          stream.destroy();
          return reject(Errors.archiveRejected('invalid mimetype entry'));
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('ascii').trim()));
      stream.on('error', reject);
    });
  });
}

/**
 * Reads only the zip central directory (no full extraction) and rejects archives that look like zip bombs.
 * Declared sizes can be forged; container memory limits and the conversion timeout are the backstop.
 */
export function inspectZip(path: string, limits: ZipLimits): Promise<ZipInspection> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, strictFileNames: false }, (openErr, zip) => {
      if (openErr || !zip) return reject(Errors.archiveRejected('corrupted archive'));

      const names: string[] = [];
      let odfMimetype: string | undefined;
      let totalUncompressed = 0;
      let settled = false;

      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(e);
      };

      if (zip.entryCount > limits.maxEntries) return fail(Errors.archiveRejected('too many entries'));

      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > limits.maxUncompressedBytes) {
          return fail(Errors.archiveRejected('uncompressed size too large'));
        }
        if (
          entry.uncompressedSize > RATIO_CHECK_MIN_BYTES &&
          entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxRatio
        ) {
          return fail(Errors.archiveRejected('suspicious compression ratio'));
        }
        if (entry.fileName === 'mimetype') {
          readSmallEntry(zip, entry, 128)
            .then((m) => {
              odfMimetype = m;
              zip.readEntry();
            })
            .catch(fail);
          return;
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ names, odfMimetype });
      });
      zip.on('error', () => fail(Errors.archiveRejected('corrupted archive')));
      zip.readEntry();
    });
  });
}

function ooxmlFormat(names: string[]): DocFormat | undefined {
  if (!names.includes('[Content_Types].xml')) return undefined;
  if (names.some((n) => n.startsWith('word/'))) return 'docx';
  if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
  if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
  return undefined;
}

/**
 * Determines the real document format from file content. The client-supplied name only breaks the tie
 * inside the legacy OLE2 family (doc/xls/ppt), which share one container signature.
 */
export async function detectFormat(path: string, originalName: string, limits: ZipLimits): Promise<DocFormat> {
  const head = await readHead(path, 8);
  const ext = extensionOf(originalName);

  if (head.subarray(0, 8).equals(OLE2_MAGIC)) {
    if (OLE2_FORMATS.has(ext as DocFormat)) return ext as DocFormat;
    // Encrypted OOXML files are also OLE2 containers; LibreOffice cannot open them without a password.
    throw Errors.unsupportedFormat();
  }

  if (head.subarray(0, 4).equals(ZIP_MAGIC)) {
    const { names, odfMimetype } = await inspectZip(path, limits);
    const odf = odfMimetype ? ODF_MIMETYPES[odfMimetype] : undefined;
    const format = odf ?? ooxmlFormat(names);
    if (format) return format;
    throw Errors.unsupportedFormat();
  }

  if (head.subarray(0, 5).equals(RTF_MAGIC)) return 'rtf';

  throw Errors.unsupportedFormat();
}
