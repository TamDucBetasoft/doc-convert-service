import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormat, type ZipLimits } from '../src/fileType.js';
import {
  VIETNAMESE_LINES,
  makeDocx,
  makeOdf,
  makeOle2Header,
  makeRtf,
  makeXlsx,
  makeZipBomb,
} from './fixtures/documents.js';

const limits: ZipLimits = { maxUncompressedBytes: 50 * 1024 * 1024, maxEntries: 100, maxRatio: 100 };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pcs-filetype-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function detect(content: Buffer, name: string, l: ZipLimits = limits) {
  const path = join(dir, `${Math.random()}`);
  await writeFile(path, content);
  return detectFormat(path, name, l);
}

describe('detectFormat', () => {
  it('detects OOXML by archive content, ignoring a misleading extension', async () => {
    expect(await detect(makeDocx(VIETNAMESE_LINES), 'report.pdf')).toBe('docx');
    expect(await detect(makeXlsx({ A: [['1']] }), 'x.docx')).toBe('xlsx');
  });

  it('detects ODF by its mimetype entry', async () => {
    expect(await detect(makeOdf('application/vnd.oasis.opendocument.text'), 'a')).toBe('odt');
    expect(await detect(makeOdf('application/vnd.oasis.opendocument.spreadsheet'), 'a')).toBe('ods');
    expect(await detect(makeOdf('application/vnd.oasis.opendocument.presentation'), 'a')).toBe('odp');
  });

  it('detects RTF', async () => {
    expect(await detect(makeRtf('hello'), 'notes.txt')).toBe('rtf');
  });

  it('uses the extension only to split the OLE2 family', async () => {
    expect(await detect(makeOle2Header(), 'old.DOC')).toBe('doc');
    expect(await detect(makeOle2Header(), 'old.xls')).toBe('xls');
    await expect(detect(makeOle2Header(), 'protected.docx')).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('rejects non-office content', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    await expect(detect(png, 'image.docx')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(detect(Buffer.from('PK\u0003\u0004garbage'), 'x.docx')).rejects.toMatchObject({
      code: 'archive_rejected',
    });
  });

  it('rejects zip bombs from the central directory without inflating them', async () => {
    const bomb = makeZipBomb(30 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(100 * 1024);
    await expect(detect(bomb, 'bomb.docx')).rejects.toMatchObject({ code: 'archive_rejected' });
    await expect(
      detect(bomb, 'bomb.docx', { ...limits, maxRatio: 1_000_000, maxUncompressedBytes: 10 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'archive_rejected' });
  });

  it('rejects archives with too many entries', async () => {
    await expect(detect(makeXlsx({ A: [['1']] }), 'x.xlsx', { ...limits, maxEntries: 2 })).rejects.toMatchObject({
      code: 'archive_rejected',
    });
  });
});
