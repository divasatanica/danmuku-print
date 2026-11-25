import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLabelTime,
  makeTestLabel,
  parseJobId,
  renderTestBitmap,
} from './print-tspl-macos.mjs';

const HPRT_HEADER_BYTES = 512;

function isBlack(bitmap, x, y) {
  const byte = bitmap.data[y * bitmap.rowBytes + (x >> 3)];
  return (byte & (0x80 >> (x & 7))) === 0;
}

test('builds a 40x30 mm BITMAP TSPL label with the HPRT header', () => {
  const timestamp = new Date(2026, 10, 24, 9, 5, 7);
  const label = makeTestLabel({ timestamp });

  assert.equal(label.subarray(0, HPRT_HEADER_BYTES).every((byte) => byte === 0), true);
  assert.equal(label[HPRT_HEADER_BYTES], 0x0d);
  assert.equal(label[HPRT_HEADER_BYTES + 1], 0x0a);

  const text = label.toString('latin1');
  assert.ok(text.includes('\r\nSIZE 40 mm, 30 mm\r\n'));
  assert.ok(text.includes('\r\nBITMAP 0,0,40,240,1,'));
  assert.equal(
    text.includes('TEXT '),
    false,
    'this printer ignores TSPL TEXT commands',
  );
  assert.ok(text.endsWith('\r\nPRINT 1,1\r\n'));

  const bitmapOffset = label.indexOf(Buffer.from('BITMAP 0,0,40,240,1,', 'ascii'))
    + Buffer.byteLength('BITMAP 0,0,40,240,1,');
  const printOffset = label.indexOf(Buffer.from('\r\nPRINT 1,1\r\n'), bitmapOffset);
  assert.equal(printOffset - bitmapOffset, 40 * 240);

  const expectedBitmap = renderTestBitmap({ timestamp });
  assert.deepEqual(
    label.subarray(bitmapOffset, bitmapOffset + 40 * 240),
    expectedBitmap.data,
    'bitmap data must follow the BITMAP command without a CRLF',
  );
});

test('renders a complete 320x240 bitmap with a right safety margin', () => {
  const bitmap = renderTestBitmap({
    timestamp: new Date(2026, 10, 24, 9, 5, 7),
  });

  assert.equal(bitmap.width, 320);
  assert.equal(bitmap.height, 240);
  assert.equal(bitmap.rowBytes, 40);

  assert.equal(isBlack(bitmap, 0, 0), true);
  assert.equal(isBlack(bitmap, 287, 0), true);
  assert.equal(isBlack(bitmap, 287, 221), true);
  assert.equal(isBlack(bitmap, 319, 120), false, 'right 4 mm must stay white');

  let titlePixels = 0;
  for (let x = 0; x < 288; x += 1) {
    if (isBlack(bitmap, x, 20)) titlePixels += 1;
  }
  assert.ok(titlePixels > 20, 'title should be drawn');

  let barcodePixels = 0;
  for (let x = 0; x < 288; x += 1) {
    if (isBlack(bitmap, x, 90)) barcodePixels += 1;
  }
  assert.ok(barcodePixels > 30, 'barcode should be drawn');
});

test('rejects label sizes outside the N31D media range', () => {
  assert.throws(() => renderTestBitmap({ widthMm: 39 }), /between 40 mm and 80 mm/);
  assert.throws(() => renderTestBitmap({ widthMm: 81 }), /between 40 mm and 80 mm/);
  assert.throws(() => renderTestBitmap({ heightMm: 24 }), /between 25 mm and 300 mm/);
});

test('formats the label timestamp in local time', () => {
  assert.equal(
    formatLabelTime(new Date(2026, 0, 2, 3, 4, 5)),
    '2026-01-02 03:04:05',
  );
});

test('parses the job id from localized lp output', () => {
  assert.equal(
    parseJobId('request id is HPRT_N31D-42 (1 file(s))', 'HPRT_N31D'),
    'HPRT_N31D-42',
  );
  assert.equal(
    parseJobId('请求id是HPRT_N31D-1（1个文件）', 'HPRT_N31D'),
    'HPRT_N31D-1',
  );
  assert.equal(parseJobId('request id is OTHER-7 (1 file(s))', 'HPRT_N31D'), null);
});
