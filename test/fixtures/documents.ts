import { strToU8, zipSync, type Zippable } from 'fflate';

const xml = (body: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`);
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ROOT_RELS = (target: string) =>
  xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>` +
      `</Relationships>`,
  );

/** Smallest valid .docx that Word and LibreOffice open: one paragraph per line. */
export function makeDocx(lines: string[]): Buffer {
  const paragraphs = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${escape(l)}</w:t></w:r></w:p>`).join('');
  const files: Zippable = {
    '[Content_Types].xml': xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    ),
    '_rels/.rels': ROOT_RELS('word/document.xml'),
    'word/document.xml': xml(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(files));
}

/** Smallest valid .xlsx: one sheet per entry, inline strings so no sharedStrings part is needed. */
export function makeXlsx(sheets: Record<string, string[][]>): Buffer {
  const names = Object.keys(sheets);
  const files: Zippable = {
    '[Content_Types].xml': xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        names
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        `</Types>`,
    ),
    '_rels/.rels': ROOT_RELS('xl/workbook.xml'),
    'xl/workbook.xml': xml(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names.map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        names
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    ),
  };
  names.forEach((name, i) => {
    const rows = sheets[name]!
      .map(
        (cells, r) =>
          `<row r="${r + 1}">` +
          cells.map((c) => `<c t="inlineStr"><is><t>${escape(c)}</t></is></c>`).join('') +
          `</row>`,
      )
      .join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = xml(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  return Buffer.from(zipSync(files));
}

/** ODF requires an uncompressed "mimetype" entry first; content is not validated by the gateway. */
export function makeOdf(mimetype: string): Buffer {
  return Buffer.from(
    zipSync({
      mimetype: [strToU8(mimetype), { level: 0 }],
      'content.xml': xml('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>'),
    }),
  );
}

export function makeRtf(text: string): Buffer {
  return Buffer.from(`{\\rtf1\\ansi ${text}}`, 'latin1');
}

export function makeOle2Header(): Buffer {
  const buf = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf);
  return buf;
}

/** A docx-shaped archive whose single entry inflates from a few KB to `bytes` of zeros. */
export function makeZipBomb(bytes: number): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': xml('<Types/>'),
      'word/document.xml': [new Uint8Array(bytes), { level: 9 }],
    }),
  );
}

export const VIETNAMESE_LINES = [
  'Hợp đồng thử nghiệm chuyển đổi tài liệu',
  'Tiếng Việt có dấu: ă â đ ê ô ơ ư — Ắ Ằ Ẳ Ẵ Ặ ồ ổ ỗ ộ ứ ừ ử ữ ự',
  'Ngày 02/11/2026 · Số tiền: 1.234.567 ₫',
  '中文测试 · 日本語テスト · 한국어 테스트 · العربية · ภาษาไทย',
];
