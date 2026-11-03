import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VIETNAMESE_LINES, makeDocx, makeRtf, makeXlsx } from '../test/fixtures/documents.js';

const out = join(import.meta.dirname, '..', 'samples', 'generated');
await mkdir(out, { recursive: true });

await writeFile(join(out, 'vi-multiscript.docx'), makeDocx(VIETNAMESE_LINES));
await writeFile(
  join(out, 'vi-two-sheets.xlsx'),
  makeXlsx({
    'Doanh thu': [
      ['Tháng', 'Số tiền (₫)', 'Ghi chú'],
      ['01/2026', '12.500.000', 'Đạt chỉ tiêu'],
      ['02/2026', '9.800.000', 'Tết Nguyên Đán'],
    ],
    'Chi phí': [
      ['Hạng mục', 'Số tiền (₫)'],
      ['Máy chủ', '1.200.000'],
    ],
  }),
);
await writeFile(join(out, 'plain.rtf'), makeRtf('Sample RTF document for conversion tests.'));

console.log(`samples written to ${out}`);
