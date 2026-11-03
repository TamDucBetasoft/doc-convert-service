import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormat } from '../src/fileType.js';
import { fitToWidth, freezeCachedValues, prepareXlsx, usedWidth } from '../src/xlsxPrep.js';
import { makeXlsxFromSheets } from './fixtures/documents.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const ws = (body: string) => `<worksheet ${NS}>${body}</worksheet>`;
const data = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="J1"><v>1</v></c></row></sheetData>';
const wideCols = '<cols><col min="1" max="10" width="20" customWidth="1"/></cols>';
const margins = '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';

describe('fitToWidth', () => {
  it('adds fit-to-page and a width-only fit to a sheet without print settings', () => {
    const { xml, changes } = fitToWidth(ws(data + margins));
    expect(changes).toContain('fit-to-width');
    expect(xml).toContain('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    expect(xml).toMatch(/<pageMargins[^>]*\/><pageSetup fitToWidth="1" fitToHeight="0"\/>/);
  });

  it('keeps element order: sheetPr first, pageSetup before drawing when there are no margins', () => {
    const { xml } = fitToWidth(ws(`<dimension ref="A1:J1"/>${data}<drawing r:id="rId1"/>`));
    expect(xml.indexOf('<sheetPr>')).toBeLessThan(xml.indexOf('<dimension'));
    expect(xml.indexOf('<pageSetup')).toBeLessThan(xml.indexOf('<drawing'));
  });

  it('switches wide sheets to landscape but respects an explicit orientation', () => {
    expect(usedWidth(ws(`<dimension ref="A1:J1"/>${wideCols}${data}`))).toBe(200);
    expect(fitToWidth(ws(`${wideCols}${data}${margins}`)).changes).toContain('landscape');
    const portrait = fitToWidth(ws(`${wideCols}${data}${margins}<pageSetup orientation="portrait"/>`));
    expect(portrait.changes).not.toContain('landscape');
    expect(portrait.xml).toContain('<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/>');
  });

  it('completes an empty pageSetUpPr written by openpyxl', () => {
    const { xml } = fitToWidth(ws(`<sheetPr><outlinePr summaryBelow="1"/><pageSetUpPr /></sheetPr>${data}`));
    expect(xml).toContain('<sheetPr><outlinePr summaryBelow="1"/><pageSetUpPr fitToPage="1"/></sheetPr>');
  });

  it('leaves sheets alone when the author already chose fit-to-page or a scale', () => {
    const fitted = ws(`<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${data}<pageSetup fitToWidth="2"/>`);
    expect(fitToWidth(fitted)).toEqual({ xml: fitted, changes: [] });
    const scaled = ws(`${data}${margins}<pageSetup scale="70"/>`);
    expect(fitToWidth(scaled)).toEqual({ xml: scaled, changes: [] });
  });
});

describe('freezeCachedValues', () => {
  it('replaces formulas with their cached values when every formula has one', () => {
    const sheet = ws(
      '<sheetData><row r="1">' +
        '<c r="A1" t="str"><f>IMAGE("https://example.com/a.png")</f><v></v></c>' +
        '<c r="B1"><f>SUM(1,2)</f><v>3</v></c><c r="C1" s="4"/>' +
        '</row></sheetData>',
    );
    const { xml, changes } = freezeCachedValues(sheet);
    expect(changes).toEqual(['cached-values']);
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('<c r="B1"><v>3</v></c>');
    expect(xml).toContain('<c r="C1" s="4"/>');
  });

  it('keeps every formula when one lacks a cached value, since shared formulas depend on each other', () => {
    const sheet = ws(
      '<sheetData><row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f><v>2</v></c>' +
        '</row><row r="2"><c r="A2"><f t="shared" si="0"/></c></row></sheetData>',
    );
    expect(freezeCachedValues(sheet)).toEqual({ xml: sheet, changes: [] });
  });
});

describe('prepareXlsx', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pcs-xlsxprep-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a valid xlsx with the changes listed per sheet', async () => {
    const input = join(dir, 'in.xlsx');
    const output = join(dir, 'out.xlsx');
    await writeFile(input, makeXlsxFromSheets([ws(`${wideCols}${data}${margins}`), ws(data + margins)]));

    const result = await prepareXlsx(input, output, 10 * 1024 * 1024);
    expect(result.changed).toBe(true);
    expect(result.sheets['xl/worksheets/sheet1.xml']).toEqual(['fit-to-width', 'landscape']);
    expect(result.sheets['xl/worksheets/sheet2.xml']).toEqual(['fit-to-width']);

    const files = unzipSync(await readFile(output));
    expect(strFromU8(files['xl/worksheets/sheet1.xml']!)).toContain('orientation="landscape"');
    expect(await detectFormat(output, 'out.xlsx', { maxUncompressedBytes: 1e8, maxEntries: 100, maxRatio: 1000 })).toBe(
      'xlsx',
    );
  });

  it('does not write anything when no sheet needs changes', async () => {
    const input = join(dir, 'fitted.xlsx');
    const output = join(dir, 'fitted-out.xlsx');
    await writeFile(input, makeXlsxFromSheets([ws(`<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${data}`)]));
    expect(await prepareXlsx(input, output, 10 * 1024 * 1024)).toEqual({ changed: false, sheets: {} });
    await expect(readFile(output)).rejects.toThrow();
  });

  it('refuses archives that unpack beyond the limit', async () => {
    const input = join(dir, 'big.xlsx');
    await writeFile(input, makeXlsxFromSheets([ws(data)]));
    await expect(prepareXlsx(input, join(dir, 'big-out.xlsx'), 100)).rejects.toThrow(/too large/);
  });
});
