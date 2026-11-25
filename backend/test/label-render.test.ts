import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitmapBit } from '../src/printing/bitmap.ts';
import type { Bitmap } from '../src/printing/bitmap.ts';
import { labelFontCandidates, resolveLabelFontPath } from '../src/printing/font.ts';
import {
  BRAND_TEXT,
  FOOTER_TEXT,
  PRICE_PREFIX,
  normalizeLabelOptions,
  renderLabel,
  renderLabelBitmap,
  timestampText,
} from '../src/printing/render-label.ts';
import type { PrintJob } from '../src/printer.ts';

const TIMESTAMP = Date.parse('2026-11-24T07:24:11Z');

/** 默认版式下各行占据的纵向窗口（内容区 16..223）。 */
const ROW_WINDOW = {
  top: { x0: 16, y0: 20, x1: 304, y1: 48 },
  nickname: { x0: 16, y0: 50, x1: 304, y1: 86 },
  price: { x0: 16, y0: 86, x1: 304, y1: 118 },
  vip: { x0: 16, y0: 118, x1: 304, y1: 145 },
  time: { x0: 16, y0: 145, x1: 304, y1: 178 },
  footer: { x0: 16, y0: 178, x1: 304, y1: 224 },
} as const;

/** 首行左右两端的检测窗口：左侧品牌固定，右侧编号随观众变化。 */
const TOP_LEFT = { x0: 16, y0: 20, x1: 205, y1: 48 } as const;
const TOP_RIGHT = { x0: 205, y0: 20, x1: 304, y1: 48 } as const;

function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    viewerNumber: 12,
    nickname: '小明同学',
    content: '12.5',
    roomId: '123456',
    eventId: 'event-1',
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface InkBand extends Box {
  top: number;
  bottom: number;
}

function hasInk(bitmap: Bitmap, box: Box): boolean {
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      if (bitmapBit(bitmap, x, y) === 0) return true;
    }
  }
  return false;
}

function inkBounds(bitmap: Bitmap, area?: Box): Box | null {
  const x0 = area?.x0 ?? 0;
  const y0 = area?.y0 ?? 0;
  const x1 = area?.x1 ?? bitmap.width;
  const y1 = area?.y1 ?? bitmap.height;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (bitmapBit(bitmap, x, y) === 0) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }
  return left === Infinity ? null : { x0: left, y0: top, x1: right, y1: bottom };
}

/** 把有墨的连续行合并成行块，用来检查版式顺序和行间距。 */
function inkBands(bitmap: Bitmap): InkBand[] {
  const inkRows: boolean[] = [];
  for (let y = 0; y < bitmap.height; y += 1) {
    let ink = false;
    for (let x = 0; x < bitmap.width; x += 1) {
      if (bitmapBit(bitmap, x, y) === 0) {
        ink = true;
        break;
      }
    }
    inkRows.push(ink);
  }
  const bands: InkBand[] = [];
  for (let y = 0; y < inkRows.length; y += 1) {
    if (!inkRows[y]) continue;
    const top = y;
    while (y + 1 < inkRows.length && inkRows[y + 1]) y += 1;
    const bounds = inkBounds(bitmap, { x0: 0, y0: top, x1: bitmap.width, y1: y + 1 })!;
    bands.push({ ...bounds, top, bottom: y });
  }
  return bands;
}

function darkPixels(bitmap: Bitmap): number {
  let count = 0;
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) if (bitmapBit(bitmap, x, y) === 0) count += 1;
  }
  return count;
}

function assertBlank(bitmap: Bitmap, box: Box, message: string): void {
  assert.equal(hasInk(bitmap, box), false, message);
}

function slice(bitmap: Bitmap, box: Box): number[] {
  const values: number[] = [];
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) values.push(bitmapBit(bitmap, x, y));
  }
  return values;
}

test('默认 40 × 30 mm 输出 320 × 240 点，内容区 288 × 208', () => {
  const canvas = renderLabel(job());
  assert.equal(canvas.width, 320);
  assert.equal(canvas.height, 240);
  const bitmap = renderLabelBitmap(job());
  assert.equal(bitmap.width, 320);
  assert.equal(bitmap.height, 240);
  assert.equal(bitmap.rowBytes, 40);
  assert.equal(bitmap.data.length, 9600);

  const options = normalizeLabelOptions();
  assert.equal(options.widthMm, 40);
  assert.equal(options.heightMm, 30);
  assert.equal(options.insetMm, 2);
  assert.equal(options.border, false);
  assert.equal(options.timeZone, 'Asia/Shanghai');
});

test('左右上下各留 2 mm，内容不侵入内边距', () => {
  const bitmap = renderLabelBitmap(job());
  assertBlank(bitmap, { x0: 0, y0: 0, x1: 16, y1: 240 }, '左侧 2 mm 内边距应为空');
  assertBlank(bitmap, { x0: 304, y0: 0, x1: 320, y1: 240 }, '右侧 2 mm 内边距应为空');
  assertBlank(bitmap, { x0: 0, y0: 0, x1: 320, y1: 16 }, '顶部 2 mm 内边距应为空');
  assertBlank(bitmap, { x0: 0, y0: 224, x1: 320, y1: 240 }, '底部 2 mm 内边距应为空');

  const bounds = inkBounds(bitmap);
  assert.ok(bounds, '标签上应有内容');
  assert.ok(bounds.x0 >= 16 && bounds.x1 <= 304, '内容应落在内容区宽度内');
  assert.ok(bounds.y0 >= 16 && bounds.y1 <= 224, '内容应落在内容区高度内');
});

test('六行顺序为 首行/昵称/价格/VIP/时间/免责声明，互不重叠', () => {
  const bitmap = renderLabelBitmap(job());
  const bands = inkBands(bitmap);
  assert.equal(bands.length, 6, `应正好有 6 行，实际 ${bands.length} 行`);
  const names = ['top', 'nickname', 'price', 'vip', 'time', 'footer'] as const;
  bands.forEach((band, index) => {
    assert.ok(band.top >= 16 && band.bottom <= 223, `${names[index]} 行应在内容区内`);
    const window = ROW_WINDOW[names[index]];
    assert.ok(hasInk(bitmap, window), `${names[index]} 行应有内容`);
  });
  for (let index = 1; index < bands.length; index += 1) {
    assert.ok(
      bands[index].top - bands[index - 1].bottom >= 5,
      `行 ${names[index - 1]} 与 ${names[index]} 之间应有间距`,
    );
  }
});

test('首行左侧固定纸纸文创，右侧是纯数字编号', () => {
  assert.equal(BRAND_TEXT, '纸纸文创');
  const bitmap = renderLabelBitmap(job({ viewerNumber: 12 }));
  const brandBand = inkBounds(bitmap, TOP_LEFT)!;
  assert.ok(brandBand, '首行左侧应有品牌文字');
  assert.ok(brandBand.x1 - brandBand.x0 >= 40, '品牌文字应完整显示');

  const numberBand = inkBounds(bitmap, TOP_RIGHT)!;
  assert.ok(numberBand, '首行右侧应有编号');
  assert.ok(numberBand.x1 >= 296, '编号应右对齐到内容区右边界');
  assert.ok(numberBand.x1 - numberBand.x0 <= 45, '编号应是纯数字，不带 VIP 字样');
  assert.ok(numberBand.y1 - numberBand.y0 >= 16, '编号字号应比品牌更醒目');

  // 换观众数据：左侧品牌不变，右侧编号变化。
  const other = renderLabelBitmap(job({
    viewerNumber: 987654,
    nickname: '另一个很长的观众昵称',
    content: '888.88',
  }));
  assert.deepEqual(slice(bitmap, TOP_LEFT), slice(other, TOP_LEFT), '首行左侧固定文字不应随弹幕变化');
  assert.notDeepEqual(slice(bitmap, TOP_RIGHT), slice(other, TOP_RIGHT), '右上角编号应随观众变化');
  const wider = inkBounds(other, TOP_RIGHT)!;
  assert.ok(wider.x1 - wider.x0 > numberBand.x1 - numberBand.x0, '更多位数的编号应更宽');
});

test('VIP 行在价格下面，价格与 VIP 字号对齐，昵称最大', () => {
  const bitmap = renderLabelBitmap(job());
  const price = inkBounds(bitmap, ROW_WINDOW.price)!;
  const vip = inkBounds(bitmap, ROW_WINDOW.vip)!;
  const nickname = inkBounds(bitmap, ROW_WINDOW.nickname)!;
  assert.ok(price && vip && nickname);

  assert.ok(vip.y0 > price.y1, 'VIP 行应在价格行下方');
  assert.ok(vip.y1 < inkBounds(bitmap, ROW_WINDOW.time)!.y0, 'VIP 行应在时间行上方');

  // 两行同号 22 px：中文“价格”墨高约 20 点，拉丁“VIP”约 16 点，差距来自字形本身。
  assert.ok(price.y1 - price.y0 >= 18 && price.y1 - price.y0 <= 24, '价格字高应接近 22 px');
  assert.ok(vip.y1 - vip.y0 >= 14 && vip.y1 - vip.y0 <= 18, 'VIP 字高应接近 22 px');
  assert.ok(nickname.y1 - nickname.y0 > price.y1 - price.y0, '昵称应仍比价格大');
  assert.ok(nickname.y1 - nickname.y0 >= 28, `昵称字高应接近 32 px，实际 ${nickname.y1 - nickname.y0}`);

  // 价格行不随观众编号变化，VIP 行随编号变化。
  const other = renderLabelBitmap(job({ viewerNumber: 987654 }));
  assert.deepEqual(slice(bitmap, ROW_WINDOW.price), slice(other, ROW_WINDOW.price));
  assert.notDeepEqual(slice(bitmap, ROW_WINDOW.vip), slice(other, ROW_WINDOW.vip));
});

test('价格行不大于 VIP 行，仍大于时间行', () => {
  const bitmap = renderLabelBitmap(job());
  const price = inkBounds(bitmap, ROW_WINDOW.price)!;
  const vip = inkBounds(bitmap, ROW_WINDOW.vip)!;
  const time = inkBounds(bitmap, ROW_WINDOW.time)!;
  assert.ok(price && vip && time);
  assert.ok(price.y1 - price.y0 <= 24, `价格字高应不超过 24 点，实际 ${price.y1 - price.y0}`);
  assert.ok(price.y1 - price.y0 > time.y1 - time.y0, '价格应仍大于时间行');
  assert.ok(vip.y1 - vip.y0 > time.y1 - time.y0, 'VIP 应仍大于时间行');
});

test('免责声明原文固定为纸制品默认微瑕，不退不换', () => {
  assert.equal(FOOTER_TEXT, '纸制品默认微瑕，不退不换');
  assert.equal(PRICE_PREFIX, '价格');
  const bitmap = renderLabelBitmap(job());
  const bounds = inkBounds(bitmap, ROW_WINDOW.footer);
  assert.ok(bounds, '底部应有免责声明墨迹');
  assert.ok(bounds.x1 - bounds.x0 >= 200, '免责声明宽度应覆盖大部分文字');
  assert.ok(bounds.x1 - bounds.x0 <= 288, '免责声明不应超出内容区');
  assert.ok(bounds.y1 - bounds.y0 >= 15, '免责声明字号不应过小（热敏打印需要足够笔画）');
  assertBlank(bitmap, { x0: 304, y0: 178, x1: 320, y1: 224 }, '免责声明不应越过右边距');
});

test('时间戳按 Asia/Shanghai 格式化为 YYYY-MM-DD HH:mm:ss，并可用时区覆盖', () => {
  assert.equal(timestampText(TIMESTAMP), '2026-11-24 15:24:11');
  assert.equal(timestampText(TIMESTAMP, 'Asia/Shanghai'), '2026-11-24 15:24:11');
  assert.equal(timestampText(TIMESTAMP, 'UTC'), '2026-11-24 07:24:11');
  assert.equal(timestampText(TIMESTAMP, 'America/New_York'), '2026-11-24 02:24:11');
  assert.throws(() => timestampText(Number.NaN), RangeError);
  assert.throws(() => timestampText(TIMESTAMP, 'Mars/Olympus'), RangeError);
  assert.notEqual(timestampText(TIMESTAMP), timestampText(TIMESTAMP + 1000));
});

test('同一输入连续渲染输出完全一致的字节', () => {
  const first = renderLabelBitmap(job());
  const second = renderLabelBitmap(job());
  assert.deepEqual(first.data, second.data);
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
});

test('尺寸可配置，输出点数与毫米一致', () => {
  const bitmap = renderLabelBitmap(job(), { widthMm: 50, heightMm: 40 });
  assert.equal(bitmap.width, 400);
  assert.equal(bitmap.height, 320);
  assertBlank(bitmap, { x0: 0, y0: 0, x1: 16, y1: 320 }, '自定义尺寸也应保留 2 mm 内边距');
  assert.equal(inkBands(bitmap).length, 6, '自定义尺寸仍应保持六行');
});

test('边框默认关闭，开启后画在距纸边 1 mm（8 点）处', () => {
  const off = renderLabelBitmap(job());
  assert.equal(bitmapBit(off, 8, 8), 1, '边框关闭时 (8,8) 应为白色');

  const on = renderLabelBitmap(job(), { border: true });
  for (const [x, y] of [[8, 8], [9, 8], [8, 9], [311, 8], [8, 231], [311, 231]]) {
    assert.equal(bitmapBit(on, x, y), 0, `边框开启时 (${x},${y}) 应为黑色`);
  }
  assert.equal(bitmapBit(on, 7, 8), 1, '边框外侧 1 mm 以内不应有墨');
  assert.equal(bitmapBit(on, 4, 4), 1, '边框外侧应为白色');
  assert.equal(bitmapBit(on, 12, 12), 1, '边框内侧与内容之间应为白色');
  assert.equal(hasInk(on, { x0: 0, y0: 0, x1: 8, y1: 240 }), false, '边框外侧保持空白');
  assert.equal(hasInk(on, { x0: 10, y0: 10, x1: 310, y1: 230 }), true, '边框内部仍有内容');
});

test('长昵称会缩小或截断，不会超出内容区', () => {
  const bitmap = renderLabelBitmap(job({ nickname: '这是一个特别特别长的观众昵称'.repeat(4) }));
  assertBlank(bitmap, { x0: 0, y0: 0, x1: 16, y1: 240 }, '长昵称不应溢出左边');
  assertBlank(bitmap, { x0: 304, y0: 0, x1: 320, y1: 240 }, '长昵称不应溢出右边');
  const bounds = inkBounds(bitmap, ROW_WINDOW.nickname)!;
  assert.ok(bounds, '长昵称仍应显示在昵称行');
  assert.ok(bounds.x1 - bounds.x0 <= 288);
});

test('长价格逐级缩小到最小字号后截断', () => {
  const bitmap = renderLabelBitmap(job({ content: '8'.repeat(60) }));
  const bounds = inkBounds(bitmap, ROW_WINDOW.price)!;
  assert.ok(bounds.x1 <= 304 && bounds.x0 >= 16, '价格不应超出内容区');
  assert.ok(bounds.x1 - bounds.x0 >= 250, '截断后的价格应基本占满可用宽度');
  assert.ok(bounds.y1 - bounds.y0 <= 26, '长价格应缩小到较小字号');
  assertBlank(bitmap, { x0: 0, y0: 0, x1: 16, y1: 240 }, '价格不应溢出左边距');
});

test('emoji 和空内容都能渲染，空内容显示价格前缀且不占昵称行', () => {
  const emoji = renderLabelBitmap(job({ nickname: '🎉观众🎉', content: '66.6 😀🚀' }));
  assert.ok(hasInk(emoji, ROW_WINDOW.nickname));
  assert.ok(hasInk(emoji, ROW_WINDOW.price));

  const empty = renderLabelBitmap(job({ nickname: '', content: '' }));
  assert.ok(hasInk(empty, ROW_WINDOW.price), '空内容时仍应显示“价格”');
  assertBlank(empty, ROW_WINDOW.nickname, '空昵称时昵称行应留空');
  assert.ok(hasInk(empty, ROW_WINDOW.top), '空昵称时首行仍显示品牌和编号');

  const spacesOnly = renderLabelBitmap(job({ nickname: '   ', content: '   ' }));
  assert.deepEqual(spacesOnly.data, empty.data);
});

test('控制字符和多余空白被清理，渲染结果与干净文本一致', () => {
  const clean = renderLabelBitmap(job({ nickname: '小明', content: '12.5' }));
  const dirty = renderLabelBitmap(job({
    nickname: '  小明\u0000\u0007 ',
    content: '\u0000  12.5 \u0007\n',
  }));
  assert.deepEqual(dirty.data, clean.data);
});

test('合法配置的边界值可以渲染，非法配置抛出明确错误', () => {
  assert.doesNotThrow(() => renderLabelBitmap(job(), { widthMm: 10, heightMm: 10, insetMm: 0 }));
  assert.doesNotThrow(() => renderLabelBitmap(job(), { insetMm: 0 }));
  assert.doesNotThrow(() => renderLabelBitmap(job(), { threshold: 200 }));

  assert.throws(() => normalizeLabelOptions({ widthMm: 5 }), /标签宽度/);
  assert.throws(() => normalizeLabelOptions({ heightMm: 500 }), /标签高度/);
  assert.throws(() => normalizeLabelOptions({ insetMm: -1 }), /内边距/);
  assert.throws(() => normalizeLabelOptions({ insetMm: 30 }), /内容区/);
  assert.throws(() => normalizeLabelOptions({ timeZone: 'Bei Jing' }), /时区/);
  assert.throws(() => normalizeLabelOptions({ threshold: 0 }), /阈值/);
});

test('字体路径同时覆盖源码和构建目录，缺失时列出候选路径', () => {
  const candidates = labelFontCandidates();
  assert.ok(candidates.length >= 2);
  assert.ok(candidates.every(path => path.endsWith('NotoSansSC-Regular.ttf')));
  const found = resolveLabelFontPath();
  assert.ok(found.endsWith('NotoSansSC-Regular.ttf'));
  assert.ok(!found.includes('node_modules'));

  assert.throws(
    () => resolveLabelFontPath({ exists: () => false }),
    (error: Error) => {
      assert.match(error.message, /NotoSansSC-Regular\.ttf/);
      for (const candidate of candidates) assert.ok(error.message.includes(candidate), candidate);
      return true;
    },
  );
});

test('黑白阈值会改变打包结果', () => {
  const normal = renderLabelBitmap(job());
  const high = renderLabelBitmap(job(), { threshold: 220 });
  assert.ok(darkPixels(high) > darkPixels(normal), '提高阈值应保留更多抗锯齿灰边为黑点');
});
