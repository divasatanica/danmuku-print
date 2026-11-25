/**
 * Task 1 spike：验证 @napi-rs/canvas + 自带 Noto Sans SC 能在 320 × 240 画布上
 * 渲染中文、数字和英文，并记录渲染耗时。
 *
 * 用法：node backend/scripts/spike-render.mjs [--out /tmp/spike.png]
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf'),
  resolve(here, '..', '..', 'dist', 'backend', 'assets', 'fonts', 'NotoSansSC-Regular.ttf'),
];
const fontPath = candidates.find(path => existsSync(path));
if (!fontPath) {
  console.error(`找不到字体，已尝试：\n${candidates.map(path => `  - ${path}`).join('\n')}`);
  process.exit(1);
}

GlobalFonts.registerFromPath(fontPath);
const font = '"Noto Sans SC", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';

const outIndex = process.argv.indexOf('--out');
const out = outIndex === -1 ? resolve(here, '..', '..', 'spike-label.png') : process.argv[outIndex + 1];

const canvas = createCanvas(320, 240);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, 320, 240);
ctx.fillStyle = '#000000';

const started = performance.now();
const lines = [
  ['中文渲染 ABC xyz 0123456789', 20, 34],
  ['VIP 12 昵称：测试观众', 20, 72],
  ['价格 12.5 元', 30, 118],
  ['2026-11-24 15:24:11', 18, 158],
  ['纸制品默认微瑕，不退不换', 14, 192],
  ['emoji 😀🎉 龘 鑫 犇', 16, 222],
];
for (const [text, size, y] of lines) {
  ctx.font = `${size}px ${font}`;
  ctx.fillText(text, 8, y);
}
const png = canvas.toBuffer('image/png');
const elapsed = performance.now() - started;

writeFileSync(out, png);
console.log(`字体：${fontPath}`);
console.log(`已写入 ${out}（${canvas.width} × ${canvas.height}，${png.length} 字节）`);
console.log(`渲染 + PNG 编码耗时：${elapsed.toFixed(2)} ms`);
