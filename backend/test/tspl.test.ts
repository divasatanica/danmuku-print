import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bitmapBit,
  formatMm,
  mmToDots,
  pack1Bit,
} from '../src/printing/bitmap.ts';
import { makeTspl } from '../src/printing/tspl.ts';

type Rgba = [number, number, number, number];

function fillRgba(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgba = () => [255, 255, 255, 255],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = a;
    }
  }
  return data;
}

test('毫米换算覆盖默认 40 × 30 mm 标签', () => {
  assert.equal(mmToDots(40), 320);
  assert.equal(mmToDots(30), 240);
  assert.equal(mmToDots(2), 16);
  assert.equal(mmToDots(1), 8);
  assert.equal(formatMm(40), '40');
  assert.equal(formatMm(30.5), '30.5');
  assert.equal(formatMm(39.999), '40');
  assert.equal(formatMm(40.04), '40.04');
  assert.throws(() => mmToDots(0), RangeError);
  assert.throws(() => formatMm(Number.NaN), RangeError);
});

test('pack1Bit 把黑色像素写为 0、白色写为 1', () => {
  const rgba = fillRgba(8, 1, x => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const bitmap = pack1Bit(rgba, 8, 1);
  assert.equal(bitmap.rowBytes, 1);
  assert.equal(bitmap.data.length, 1);
  assert.equal(bitmap.data[0], 0b0111_1111);
  assert.equal(bitmapBit(bitmap, 0, 0), 0);
  for (let x = 1; x < 8; x += 1) assert.equal(bitmapBit(bitmap, x, 0), 1);
});

test('非 8 倍数宽度的末尾补白位保持白色', () => {
  const rgba = fillRgba(10, 1, x => (x >= 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const bitmap = pack1Bit(rgba, 10, 1);
  assert.equal(bitmap.rowBytes, 2);
  assert.equal(bitmap.data[0], 0xff);
  assert.equal(bitmap.data[1], 0b0011_1111);
  assert.equal(bitmapBit(bitmap, 8, 0), 0);
  assert.equal(bitmapBit(bitmap, 9, 0), 0);
});

test('阈值决定灰度像素的黑白，透明度按白底合成', () => {
  const gray = (value: number): Rgba => [value, value, value, 255];
  const rgba = fillRgba(4, 1, x => {
    if (x === 0) return gray(200);
    if (x === 1) return gray(127);
    if (x === 2) return gray(128);
    return [0, 0, 0, 0];
  });
  const bitmap = pack1Bit(rgba, 4, 1);
  assert.equal(bitmapBit(bitmap, 0, 0), 1, '200 灰度应保持白色');
  assert.equal(bitmapBit(bitmap, 1, 0), 0, '127 灰度应变成黑色');
  assert.equal(bitmapBit(bitmap, 2, 0), 1, '128 灰度在阈值 128 下是白色');
  assert.equal(bitmapBit(bitmap, 3, 0), 1, '完全透明的像素应按白底处理');
});

test('pack1Bit 拒绝非法尺寸、阈值和不完整数据', () => {
  const rgba = fillRgba(8, 8);
  assert.throws(() => pack1Bit(rgba, 0, 8), RangeError);
  assert.throws(() => pack1Bit(rgba, 8, -1), RangeError);
  assert.throws(() => pack1Bit(rgba, 8, 8, 0), RangeError);
  assert.throws(() => pack1Bit(rgba, 8, 8, 255), RangeError);
  assert.throws(() => pack1Bit(rgba.subarray(0, 10), 8, 8), /RGBA 数据不足/);
  assert.throws(() => bitmapBit(pack1Bit(rgba, 8, 8), 8, 0), RangeError);
});

function sampleBitmap() {
  const rgba = fillRgba(16, 2, (x, y) => (x === 3 && y === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  return pack1Bit(rgba, 16, 2);
}

test('makeTspl 生成 SIZE/BITMAP/PRINT 结构，BITMAP 后不加 CRLF', () => {
  const bitmap = sampleBitmap();
  const data = makeTspl(bitmap, { widthMm: 40, heightMm: 30 });
  assert.equal(data.subarray(0, 512).every(byte => byte === 0), true, '默认 512 字节头应全为 0');
  assert.deepEqual([...data.subarray(512, 514)], [0x0d, 0x0a]);

  const text = data.subarray(514).toString('latin1');
  assert.match(text, /^SIZE 40 mm, 30 mm\r\n/);
  assert.ok(text.includes('SET TEAR ON\r\n'));
  assert.ok(text.includes('SET CUTTER OFF\r\n'));
  assert.ok(text.includes('SET PEEL OFF\r\n'));
  assert.ok(text.includes('CLS\r\n'));
  assert.ok(!text.includes('TEXT '), '不应使用 TEXT 指令');
  assert.ok(!text.includes('BOX '), '不应使用 BOX 指令');

  const marker = `BITMAP 0,0,${bitmap.rowBytes},${bitmap.height},1,`;
  const markerIndex = text.indexOf(marker);
  assert.ok(markerIndex > 0, '应包含 BITMAP 指令');
  const bitmapStart = 514 + markerIndex + marker.length;
  assert.deepEqual(
    [...data.subarray(bitmapStart, bitmapStart + bitmap.data.length)],
    [...bitmap.data],
    'BITMAP 指令后必须紧跟位图数据',
  );
  assert.equal(data[bitmapStart - 1], 0x2c, 'BITMAP 指令以逗号结尾');
  assert.ok(data.subarray(bitmapStart + bitmap.data.length).toString('latin1') === '\r\nPRINT 1,1\r\n');
  assert.ok(data.toString('latin1').endsWith('\r\nPRINT 1,1\r\n'));
});

test('makeTspl 的头部长度、份数和指令开关可配置', () => {
  const bitmap = sampleBitmap();
  const withoutHeader = makeTspl(bitmap, { widthMm: 50, heightMm: 40, headerBytes: 0 });
  assert.equal(withoutHeader.subarray(0, 2).toString('latin1'), '\r\n');
  assert.ok(withoutHeader.toString('latin1').startsWith('\r\nSIZE 50 mm, 40 mm\r\n'));

  const shortHeader = makeTspl(bitmap, { widthMm: 40, heightMm: 30, headerBytes: 16 });
  assert.equal(shortHeader.subarray(0, 16).every(byte => byte === 0), true);
  assert.equal(shortHeader[16], 0x0d);

  const custom = makeTspl(bitmap, {
    widthMm: 40,
    heightMm: 30,
    headerBytes: 0,
    tear: false,
    cutter: true,
    peel: true,
    copies: 2,
  }).toString('latin1');
  assert.ok(custom.includes('SET TEAR OFF\r\n'));
  assert.ok(custom.includes('SET CUTTER ON\r\n'));
  assert.ok(custom.includes('SET PEEL ON\r\n'));
  assert.ok(custom.endsWith('\r\nPRINT 2,1\r\n'));
});

test('makeTspl 校验头部长度和份数', () => {
  const bitmap = sampleBitmap();
  assert.throws(() => makeTspl(bitmap, { widthMm: 40, heightMm: 30, headerBytes: -1 }), RangeError);
  assert.throws(() => makeTspl(bitmap, { widthMm: 40, heightMm: 30, headerBytes: 9000 }), RangeError);
  assert.throws(() => makeTspl(bitmap, { widthMm: 40, heightMm: 30, headerBytes: 1.5 }), RangeError);
  assert.throws(() => makeTspl(bitmap, { widthMm: 40, heightMm: 30, copies: 0 }), RangeError);
  assert.throws(() => makeTspl(bitmap, { widthMm: 40, heightMm: 30, copies: 101 }), RangeError);
});
