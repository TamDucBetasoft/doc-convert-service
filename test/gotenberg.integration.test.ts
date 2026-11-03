import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormat } from '../src/fileType.js';
import { GotenbergClient } from '../src/gotenberg.js';
import { prepareXlsx } from '../src/xlsxPrep.js';
import { VIETNAMESE_LINES, makeDocx, makeXlsx, makeXlsxFromSheets } from './fixtures/documents.js';

/** Runs only against a real engine: GOTENBERG_URL=http://localhost:3000 npm test */
const url = process.env.GOTENBERG_URL;

describe.skipIf(!url)('Gotenberg (integration)', () => {
  let dir: string;
  const client = new GotenbergClient(url ?? '', 60_000, 5);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pcs-gotenberg-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function convert(content: Buffer, format: string) {
    const input = join(dir, `in.${format}`);
    const output = join(dir, `out-${format}.pdf`);
    await writeFile(input, content);
    await client.convert(input, `document.${format}`, output);
    return PDFDocument.load(await readFile(output));
  }

  it('is healthy', async () => {
    expect(await client.healthy()).toBe(true);
  });

  it('converts a Vietnamese docx', async () => {
    const pdf = await convert(makeDocx(VIETNAMESE_LINES), 'docx');
    expect(pdf.getPageCount()).toBe(1);
  });

  it('converts a multi-sheet xlsx', async () => {
    const pdf = await convert(makeXlsx({ A: [['1', '2']], B: [['3']] }), 'xlsx');
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('prints a wide sheet on far fewer pages after xlsx preparation', async () => {
    const cols = '<cols><col min="1" max="10" width="30" customWidth="1"/></cols>';
    const rows = Array.from({ length: 120 }, (_, r) =>
      `<row r="${r + 1}">` +
      Array.from({ length: 10 }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>Ô ${r}-${c}</t></is></c>`).join('') +
      '</row>',
    ).join('');
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
    const original = makeXlsxFromSheets([sheet]);
    const before = await convert(original, 'xlsx');

    const input = join(dir, 'wide.xlsx');
    const prepared = join(dir, 'wide-prepared.xlsx');
    await writeFile(input, original);
    expect((await prepareXlsx(input, prepared, 1e8)).changed).toBe(true);
    const after = await convert(await readFile(prepared), 'xlsx');

    expect(after.getPageCount()).toBeLessThan(before.getPageCount() / 2);
  });

  it('renders arbitrary bytes as text, so the gateway must reject them before conversion', async () => {
    const garbage = Buffer.from('not really a docx');
    const pdf = await convert(garbage, 'docx');
    expect(pdf.getPageCount()).toBe(1);

    const path = join(dir, 'garbage.docx');
    await writeFile(path, garbage);
    await expect(
      detectFormat(path, 'garbage.docx', { maxUncompressedBytes: 1e8, maxEntries: 100, maxRatio: 100 }),
    ).rejects.toMatchObject({ code: 'unsupported_format' });
  });
});
