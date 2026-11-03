import { readFile, writeFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';

export type SheetChange = 'fit-to-width' | 'landscape' | 'cached-values';
export type XlsxPrepResult = { changed: boolean; sheets: Record<string, SheetChange[]> };

const SHEET_PATH = /^xl\/worksheets\/sheet\d+\.xml$/;
const CELL = /<c\b(?:\s[^>]*?)?(?:\/>|>[\s\S]*?<\/c>)/g;
const FORMULA = /<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/g;
const HAS_FORMULA = /<f[\s>/]/;
const HAS_VALUE = /<v[\s>/]/;

/** Excel column width units that fit across an A4 portrait page at 100% scale with default margins. */
const PORTRAIT_WIDTH_UNITS = 95;
const DEFAULT_COL_WIDTH = 8.43;

/** Children of <worksheet> that must come after <pageSetup> (ECMA-376 CT_Worksheet order). */
const AFTER_PAGE_SETUP = [
  'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags',
  'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems',
  'tableParts', 'extLst',
];

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function setAttrs(tag: string, attrs: Record<string, string>): string {
  let t = tag;
  for (const [name, value] of Object.entries(attrs)) {
    t = t.replace(new RegExp(`\\s${name}="[^"]*"`), '');
    t = t.replace(/\s*(\/?)>$/, ` ${name}="${value}"$1>`);
  }
  return t;
}

function lastUsedColumn(xml: string): number {
  const ref = xml.match(/<dimension\b[^>]*\sref="[A-Z]+\d+:([A-Z]+)\d+"/)?.[1];
  if (ref) return columnIndex(ref);
  let max = 0;
  for (const m of xml.matchAll(/<c\b[^>]*\sr="([A-Z]+)\d+"/g)) max = Math.max(max, columnIndex(m[1]!));
  return max;
}

/** Sum of visible column widths in the used range, in Excel character units. */
export function usedWidth(xml: string): number {
  const last = lastUsedColumn(xml);
  if (last === 0) return 0;
  const fmt = xml.match(/<sheetFormatPr\b[^>]*>/)?.[0] ?? '';
  const declared = Number(attr(fmt, 'defaultColWidth') ?? NaN);
  const fallback = Number.isFinite(declared) ? declared : DEFAULT_COL_WIDTH;
  const widths = new Array<number>(last + 1).fill(fallback);
  for (const m of xml.matchAll(/<col\b[^>]*>/g)) {
    const tag = m[0];
    const min = Number(attr(tag, 'min'));
    const max = Math.min(Number(attr(tag, 'max')), last);
    const hidden = attr(tag, 'hidden') === '1' || attr(tag, 'hidden') === 'true';
    const width = hidden ? 0 : Number(attr(tag, 'width') ?? fallback);
    for (let i = min; i <= max; i++) widths[i] = width;
  }
  return widths.slice(1).reduce((a, b) => a + b, 0);
}

/**
 * Sheets without print scaling make LibreOffice split columns across pages (a 10-column event table became 62
 * pages). Scale to the page width and let rows flow onto further pages; sheets with the user's own fit or
 * scale settings are left as they are.
 */
export function fitToWidth(xml: string): { xml: string; changes: SheetChange[] } {
  if (/^\s*(<\?xml[^>]*>\s*)?<\w+:worksheet\b/.test(xml)) return { xml, changes: [] };
  if (/<pageSetUpPr\b[^>]*\sfitToPage="(1|true)"/.test(xml)) return { xml, changes: [] };
  const pageSetup = xml.match(/<pageSetup\b[^>]*>/)?.[0];
  const scale = pageSetup ? attr(pageSetup, 'scale') : undefined;
  if (scale !== undefined && scale !== '100') return { xml, changes: [] };

  const changes: SheetChange[] = ['fit-to-width'];
  const landscape = !(pageSetup && attr(pageSetup, 'orientation')) && usedWidth(xml) > PORTRAIT_WIDTH_UNITS;
  if (landscape) changes.push('landscape');

  let out = xml;
  if (/<pageSetUpPr\b[^>]*>/.test(out)) {
    out = out.replace(/<pageSetUpPr\b[^>]*>/, (t) => setAttrs(t, { fitToPage: '1' }));
  } else if (/<sheetPr\b[^>]*\/>/.test(out)) {
    out = out.replace(/<sheetPr\b([^>]*?)\s*\/>/, '<sheetPr$1><pageSetUpPr fitToPage="1"/></sheetPr>');
  } else if (out.includes('</sheetPr>')) {
    out = out.replace('</sheetPr>', '<pageSetUpPr fitToPage="1"/></sheetPr>');
  } else {
    out = out.replace(/<worksheet\b[^>]*>/, (t) => `${t}<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`);
  }

  const fit = { fitToWidth: '1', fitToHeight: '0', ...(landscape ? { orientation: 'landscape' } : {}) };
  if (pageSetup) {
    out = out.replace(/<pageSetup\b[^>]*>/, (t) => setAttrs(t, fit));
  } else {
    const tag = setAttrs('<pageSetup/>', fit);
    const margins = out.match(/<pageMargins\b[^>]*\/>|<pageMargins\b[^>]*>[\s\S]*?<\/pageMargins>/);
    if (margins?.index !== undefined) {
      const at = margins.index + margins[0].length;
      out = out.slice(0, at) + tag + out.slice(at);
    } else {
      const next = AFTER_PAGE_SETUP.map((name) => out.search(new RegExp(`<${name}\\b`))).filter((i) => i >= 0);
      const at = next.length ? Math.min(...next) : out.lastIndexOf('</worksheet>');
      out = out.slice(0, at) + tag + out.slice(at);
    }
  }
  return { xml: out, changes };
}

/**
 * LibreOffice recalculates formulas from non-Excel generators and has no Google Sheets functions such as
 * IMAGE() or GOOGLEFINANCE(), so those print as #NAME?. When every formula in a sheet carries the value the
 * user last saw, print that value instead. Sheets with any formula lacking a cached value (openpyxl output)
 * keep all formulas, because shared formulas reference each other.
 */
export function freezeCachedValues(xml: string): { xml: string; changes: SheetChange[] } {
  const formulaCells = (xml.match(CELL) ?? []).filter((c) => HAS_FORMULA.test(c));
  if (formulaCells.length === 0 || !formulaCells.every((c) => HAS_VALUE.test(c))) return { xml, changes: [] };
  const out = xml.replace(CELL, (cell) => (HAS_FORMULA.test(cell) ? cell.replace(FORMULA, '') : cell));
  return { xml: out, changes: ['cached-values'] };
}

/**
 * Rewrites an .xlsx so LibreOffice prints it the way a spreadsheet app shows it. Writes `outputPath` only when
 * something changed. Throws on unreadable archives or when the unpacked size exceeds `maxUnpackedBytes`;
 * callers should then convert the original file.
 */
export async function prepareXlsx(inputPath: string, outputPath: string, maxUnpackedBytes: number): Promise<XlsxPrepResult> {
  let unpacked = 0;
  const files: Unzipped = unzipSync(await readFile(inputPath), {
    filter(file) {
      unpacked += file.originalSize;
      if (unpacked > maxUnpackedBytes) throw new Error('xlsx too large to prepare');
      return true;
    },
  });

  const sheets: Record<string, SheetChange[]> = {};
  for (const [name, data] of Object.entries(files)) {
    if (!SHEET_PATH.test(name)) continue;
    const original = strFromU8(data);
    const frozen = freezeCachedValues(original);
    const fitted = fitToWidth(frozen.xml);
    const changes = [...frozen.changes, ...fitted.changes];
    if (changes.length === 0) continue;
    files[name] = strToU8(fitted.xml);
    sheets[name] = changes;
  }

  const changed = Object.keys(sheets).length > 0;
  if (changed) await writeFile(outputPath, zipSync(files, { level: 6 }));
  return { changed, sheets };
}
