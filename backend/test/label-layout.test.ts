import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphemes, layoutText, sanitizeText } from '../src/printing/layout.ts';

/** 简易测量：每个字素宽度为 0.6 × 字号。 */
const measure = (text: string, sizePx: number): number => graphemes(text).length * sizePx * 0.6;

test('sanitizeText 清理控制字符、折叠空白并去首尾空格', () => {
  assert.equal(sanitizeText('  hello \t world \n'), 'hello world');
  assert.equal(sanitizeText('昵称\u0000\u0007测试'), '昵称 测试');
  assert.equal(sanitizeText('全角\u3000空格'), '全角 空格');
  assert.equal(sanitizeText('a\u200Bb\u200Ec'), 'a b c');
  assert.equal(sanitizeText('\u202A覆盖\u202C'), '覆盖');
  assert.equal(sanitizeText('   '), '');
  assert.equal(sanitizeText(undefined), '');
});

test('sanitizeText 保留 emoji 组合和变体选择符', () => {
  const family = '👨\u200D👩\u200D👧\u200D👦';
  assert.equal(graphemes(family).length, 1);
  assert.equal(sanitizeText(` ${family} `), family);
  assert.equal(graphemes('a👨\u200D👩\u200D👧\u200D👦b').length, 3);
  assert.equal(sanitizeText('❤\uFE0F'), '❤\uFE0F');
});

test('sanitizeText 做 NFC 归一化并限制字素数量', () => {
  assert.equal(sanitizeText('e\u0301'), 'é');
  assert.equal(graphemes(sanitizeText('弹幕'.repeat(100), 20)).length, 20);
  assert.equal(sanitizeText('abcdef', 3), 'abc');
});

test('layoutText 选能放下的最大字号', () => {
  const fit = layoutText('abcdef', { maxWidth: 120, sizes: [36, 32, 28, 24], measure });
  assert.equal(fit.size, 32);
  assert.equal(fit.truncated, false);
  assert.equal(fit.text, 'abcdef');
  assert(fit.width <= 120);
});

test('layoutText 在最小字号仍超宽时截断并加 ...', () => {
  const fit = layoutText('一二三四五六七八九十'.repeat(6), {
    maxWidth: 120,
    sizes: [36, 32, 28, 24],
    measure,
  });
  assert.equal(fit.size, 24);
  assert.equal(fit.truncated, true);
  assert.ok(fit.text.endsWith('...'));
  assert.ok(fit.width <= 120);
  assert.ok(graphemes(fit.text).length < 60);
});

test('layoutText 连省略号都放不下时返回空文本', () => {
  const fit = layoutText('任意文本', { maxWidth: 1, sizes: [24], measure });
  assert.equal(fit.text, '');
  assert.equal(fit.truncated, true);
  assert.equal(fit.width, 0);
});

test('layoutText 按字素截断，不拆坏 emoji 组合', () => {
  const family = '👨\u200D👩\u200D👧\u200D👦';
  const fit = layoutText(family.repeat(10), { maxWidth: 100, sizes: [24], measure });
  assert.equal(fit.truncated, true);
  assert.ok(fit.text.endsWith('...'));
  // 去掉省略号后，每个字素都应是完整的家庭 emoji。
  const kept = fit.text.slice(0, -3);
  for (const part of graphemes(kept)) assert.equal(part, family);
});

test('layoutText 处理空文本和重复字号', () => {
  const empty = layoutText('', { maxWidth: 100, sizes: [36, 24], measure });
  assert.equal(empty.text, '');
  assert.equal(empty.size, 36);
  assert.equal(empty.width, 0);

  const duplicated = layoutText('abc', { maxWidth: 1000, sizes: [24, 24, 36], measure });
  assert.equal(duplicated.size, 36);
});

test('layoutText 拒绝非法参数', () => {
  assert.throws(() => layoutText('a', { maxWidth: 0, sizes: [12], measure }), RangeError);
  assert.throws(() => layoutText('a', { maxWidth: 10, sizes: [], measure }), RangeError);
  assert.throws(() => layoutText('a', { maxWidth: 10, sizes: [0, -1], measure }), RangeError);
});
