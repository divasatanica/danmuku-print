/**
 * 动态标签渲染：把一条 PrintJob 画成 320 × 240 的 1-bit 位图。
 *
 * 版式（默认 40 × 30 mm、203 dpi、320 × 240 点）：
 *   - 左右上下各留 2 mm（16 点）内边距，内容区 288 × 208 点居中；
 *   - 首行左侧固定品牌 `纸纸文创`，右侧是单独的观众编号（不带 VIP 字样）；
 *   - 昵称单独一行，字号最大，过长时缩小或截断；
 *   - `价格 <弹幕正文>`，与下面的 VIP 行同号（默认 22 px），超宽逐级缩小；
 *   - `VIP <编号>` 放在价格下面；
 *   - `YYYY-MM-DD HH:mm:ss` 时间行；
 *   - 底部固定免责声明。
 *
 * 所有动态内容都在宿主端栅格化，不使用 TSPL TEXT/BOX。
 */
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import { mmToDots, pack1Bit } from './bitmap.ts';
import type { Bitmap } from './bitmap.ts';
import { ensureLabelFont, labelFontCss, metricsProbeText } from './font.ts';
import { layoutText, sanitizeText } from './layout.ts';
import type { TextFit } from './layout.ts';
import type { PrintJob } from '../printer.ts';

export const BRAND_TEXT = '纸纸文创';
export const FOOTER_TEXT = '纸制品默认微瑕，不退不换';
export const PRICE_PREFIX = '价格';
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export interface LabelRenderOptions {
  widthMm: number;
  heightMm: number;
  /** 左右上下对称内边距，默认 2 mm。 */
  insetMm: number;
  /** 距纸边 1 mm 的细边框，默认关闭。 */
  border: boolean;
  timeZone: string;
  /** RGBA 转 1-bit 的黑白阈值。 */
  threshold: number;
}

export const DEFAULT_LABEL_OPTIONS: LabelRenderOptions = {
  widthMm: 40,
  heightMm: 30,
  insetMm: 2,
  border: false,
  timeZone: DEFAULT_TIME_ZONE,
  threshold: 128,
};

/** 内容区最小可用点数，防止极端配置把版式压成 0。 */
const MIN_CONTENT_DOTS = 32;
const MIN_FONT_PX = 6;

/** 价格行和 VIP 行共用同一档字号（默认 22 px），保证两行对齐。 */
const BODY_SIZE_RATIO = 0.106;

/** 各行中心在内容区高度中的比例（内容区默认 208 点高）。 */
const ROW_CENTER = {
  top: 0.1,
  nickname: 0.27,
  price: 0.43,
  vip: 0.565,
  time: 0.72,
  footer: 0.895,
} as const;

/** 各行基准字号占内容区高度的比例（默认 208 点时约 18/24/28/22/22/18/20 px）。 */
const SIZE_RATIO = {
  brand: 0.086,
  corner: 0.115,
  nickname: 0.154,
  price: BODY_SIZE_RATIO,
  vip: BODY_SIZE_RATIO,
  time: 0.086,
  footer: 0.096,
} as const;

/** 价格行候选字号比例（相对 22 px 基准），对应 22/20/18/16 px。 */
const PRICE_SIZE_RATIOS = [1, 0.909, 0.818, 0.727] as const;
/** 昵称缩小比例。 */
const NICKNAME_SIZE_RATIOS = [1, 0.9, 0.8, 0.7] as const;
/** 品牌行的缩小比例。 */
const BRAND_SIZE_RATIOS = [1, 0.9] as const;

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min} 到 ${max} 之间的数值，收到 ${value}。`);
  }
}

function assertInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min} 到 ${max} 之间的整数，收到 ${value}。`);
  }
}

/** 合并并校验渲染选项，配置错误在启动阶段就暴露。 */
export function normalizeLabelOptions(options: Partial<LabelRenderOptions> = {}): LabelRenderOptions {
  const merged: LabelRenderOptions = { ...DEFAULT_LABEL_OPTIONS, ...options };
  assertRange('标签宽度（mm）', merged.widthMm, 10, 120);
  assertRange('标签高度（mm）', merged.heightMm, 10, 300);
  assertRange('标签内边距（mm）', merged.insetMm, 0, 40);
  assertInteger('黑白阈值', merged.threshold, 1, 254);
  if (typeof merged.border !== 'boolean') throw new TypeError('边框开关必须是布尔值。');
  if (!isValidTimeZone(merged.timeZone)) {
    throw new RangeError(`时区无效：${merged.timeZone}。图形驱动使用 IANA 时区名，例如 Asia/Shanghai。`);
  }
  const insetDots = merged.insetMm > 0 ? mmToDots(merged.insetMm) : 0;
  const contentWidth = mmToDots(merged.widthMm) - insetDots * 2;
  const contentHeight = mmToDots(merged.heightMm) - insetDots * 2;
  if (contentWidth < MIN_CONTENT_DOTS || contentHeight < MIN_CONTENT_DOTS) {
    throw new RangeError(
      `标签内边距过大：内容区只剩 ${contentWidth} × ${contentHeight} 点，至少需要 `
      + `${MIN_CONTENT_DOTS} × ${MIN_CONTENT_DOTS} 点。`,
    );
  }
  return merged;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** 把 `job.timestamp`（毫秒）格式化为 `YYYY-MM-DD HH:mm:ss`。 */
export function timestampText(timestampMs: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  if (!Number.isFinite(timestampMs)) throw new RangeError(`打印时间戳无效：${timestampMs}。`);
  if (!isValidTimeZone(timeZone)) throw new RangeError(`时区无效：${timeZone}。`);
  const parts = dateTimeFormatter(timeZone).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '';
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')} `
    + `${value('hour')}:${value('minute')}:${value('second')}`;
}

interface LineMetrics {
  ascent: number;
  descent: number;
}

/** 用固定基准文本测量竖排刻度，避免逐行文本不同导致上下跳动。 */
function lineMetrics(ctx: SKRSContext2D, sizePx: number): LineMetrics {
  ctx.font = labelFontCss(sizePx);
  const probe = ctx.measureText(metricsProbeText());
  const ascent = probe.actualBoundingBoxAscent || probe.fontBoundingBoxAscent || sizePx * 0.8;
  const descent = probe.actualBoundingBoxDescent || probe.fontBoundingBoxDescent || sizePx * 0.2;
  return { ascent, descent };
}

function baselineFor(metrics: LineMetrics, centerY: number): number {
  return centerY + (metrics.ascent - metrics.descent) / 2;
}

function measureWith(ctx: SKRSContext2D) {
  return (text: string, sizePx: number): number => {
    ctx.font = labelFontCss(sizePx);
    return ctx.measureText(text).width;
  };
}

function fontPx(contentHeight: number, ratio: number): number {
  return Math.max(MIN_FONT_PX, Math.round(contentHeight * ratio));
}

function scaledSizes(base: number, ratios: readonly number[]): number[] {
  const sizes = ratios.map(ratio => Math.max(MIN_FONT_PX, Math.round(base * ratio)));
  return [...new Set(sizes)].sort((a, b) => b - a);
}

function drawText(ctx: SKRSContext2D, text: string, sizePx: number, x: number, baseline: number): void {
  if (!text) return;
  ctx.font = labelFontCss(sizePx);
  ctx.fillText(text, Math.round(x), Math.round(baseline));
}

/** 距纸边 1 mm 的 2 点细边框，不挤压内容区。 */
function drawBorder(ctx: SKRSContext2D, width: number, height: number, marginDots: number): void {
  const thickness = 2;
  const margin = Math.max(1, marginDots);
  const inner = margin + thickness;
  if (width - inner * 2 <= 0 || height - inner * 2 <= 0) return;
  ctx.fillRect(margin, margin, width - margin * 2, thickness);
  ctx.fillRect(margin, height - margin - thickness, width - margin * 2, thickness);
  ctx.fillRect(margin, margin, thickness, height - margin * 2);
  ctx.fillRect(width - margin - thickness, margin, thickness, height - margin * 2);
}

function drawCenteredFit(
  ctx: SKRSContext2D,
  fit: TextFit,
  box: { x: number; y: number; width: number; height: number },
  centerY: number,
): void {
  drawText(ctx, fit.text, fit.size, box.x + (box.width - fit.width) / 2, baselineFor(lineMetrics(ctx, fit.size), centerY));
}

function fitLine(
  text: string,
  box: { x: number; y: number; width: number; height: number },
  baseSize: number,
  ratios: readonly number[],
  measure: (text: string, sizePx: number) => number,
): TextFit {
  return layoutText(text, { maxWidth: box.width, sizes: scaledSizes(baseSize, ratios), measure });
}

/** 首行：品牌靠左、观众编号靠右（纯数字），两者共用一条基线。 */
function drawTopRow(
  ctx: SKRSContext2D,
  job: PrintJob,
  box: { x: number; y: number; width: number; height: number },
  measure: (text: string, sizePx: number) => number,
): void {
  if (box.width <= 0 || box.height <= 0) return;
  const brandFit = fitLine(BRAND_TEXT, box, fontPx(box.height, SIZE_RATIO.brand), BRAND_SIZE_RATIOS, measure);
  const cornerBase = fontPx(box.height, SIZE_RATIO.corner);
  const numberText = sanitizeText(String(job.viewerNumber), 16) || '0';
  const gap = Math.max(6, Math.round(cornerBase * 0.5));
  const remaining = Math.max(0, box.width - brandFit.width - gap);
  const numberFit = remaining > 0
    ? layoutText(numberText, { maxWidth: remaining, sizes: scaledSizes(cornerBase, [1, 0.9, 0.8]), measure })
    : null;

  const centerY = box.y + box.height * ROW_CENTER.top;
  const baseline = baselineFor(lineMetrics(ctx, Math.max(brandFit.size, numberFit?.size ?? 0)), centerY);
  drawText(ctx, brandFit.text, brandFit.size, box.x, baseline);
  if (numberFit?.text) {
    drawText(ctx, numberFit.text, numberFit.size, box.x + box.width - numberFit.width, baseline);
  }
}

/** VIP 行放在价格下面，字号与价格一致。 */
function drawVip(
  ctx: SKRSContext2D,
  job: PrintJob,
  box: { x: number; y: number; width: number; height: number },
  measure: (text: string, sizePx: number) => number,
): void {
  const base = fontPx(box.height, SIZE_RATIO.vip);
  const text = sanitizeText(`VIP ${job.viewerNumber}`, 24) || 'VIP';
  const fit = fitLine(text, box, base, [1, 0.9], measure);
  drawCenteredFit(ctx, fit, box, box.y + box.height * ROW_CENTER.vip);
}

/** 昵称单独一行，字号比 VIP 更大；过长先缩小，仍放不下则截断。 */
function drawNickname(
  ctx: SKRSContext2D,
  job: PrintJob,
  box: { x: number; y: number; width: number; height: number },
  measure: (text: string, sizePx: number) => number,
): void {
  const nickname = sanitizeText(job.nickname, 40);
  if (!nickname) return;
  const base = fontPx(box.height, SIZE_RATIO.nickname);
  const fit = fitLine(nickname, box, base, NICKNAME_SIZE_RATIOS, measure);
  if (!fit.text) return;
  drawCenteredFit(ctx, fit, box, box.y + box.height * ROW_CENTER.nickname);
}

function drawPrice(
  ctx: SKRSContext2D,
  job: PrintJob,
  box: { x: number; y: number; width: number; height: number },
  measure: (text: string, sizePx: number) => number,
): void {
  const content = sanitizeText(job.content, 120);
  const text = content ? `${PRICE_PREFIX} ${content}` : PRICE_PREFIX;
  const base = fontPx(box.height, SIZE_RATIO.price);
  const fit = fitLine(text, box, base, PRICE_SIZE_RATIOS, measure);
  drawCenteredFit(ctx, fit, box, box.y + box.height * ROW_CENTER.price);
}

function drawTime(
  ctx: SKRSContext2D,
  job: PrintJob,
  timeZone: string,
  box: { x: number; y: number; width: number; height: number },
  measure: (text: string, sizePx: number) => number,
): void {
  const base = fontPx(box.height, SIZE_RATIO.time);
  const fit = fitLine(timestampText(job.timestamp, timeZone), box, base, [1, 0.9], measure);
  drawCenteredFit(ctx, fit, box, box.y + box.height * ROW_CENTER.time);
}

function drawFooter(
  ctx: SKRSContext2D,
  box: { x: number; y: number; width: number; height: number },
  measure: (text: string, sizePx: number) => number,
): void {
  const base = fontPx(box.height, SIZE_RATIO.footer);
  const fit = fitLine(FOOTER_TEXT, box, base, [1, 0.9], measure);
  drawCenteredFit(ctx, fit, box, box.y + box.height * ROW_CENTER.footer);
}

function renderLabelCanvas(job: PrintJob, options: LabelRenderOptions): Canvas {
  ensureLabelFont();
  const width = mmToDots(options.widthMm);
  const height = mmToDots(options.heightMm);
  const inset = options.insetMm > 0 ? mmToDots(options.insetMm) : 0;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (options.border) drawBorder(ctx, width, height, mmToDots(1));

  const box = {
    x: inset,
    y: inset,
    width: width - inset * 2,
    height: height - inset * 2,
  };
  const measure = measureWith(ctx);
  drawTopRow(ctx, job, box, measure);
  drawNickname(ctx, job, box, measure);
  drawPrice(ctx, job, box, measure);
  drawVip(ctx, job, box, measure);
  drawTime(ctx, job, options.timeZone, box, measure);
  drawFooter(ctx, box, measure);
  return canvas;
}

/** 渲染标签画布（RGBA），供预览工具直接导出 PNG。 */
export function renderLabel(job: PrintJob, options: Partial<LabelRenderOptions> = {}): Canvas {
  return renderLabelCanvas(job, normalizeLabelOptions(options));
}

/** 渲染标签并打包成打印机需要的 1-bit 位图。 */
export function renderLabelBitmap(job: PrintJob, options: Partial<LabelRenderOptions> = {}): Bitmap {
  const config = normalizeLabelOptions(options);
  const canvas = renderLabelCanvas(job, config);
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return pack1Bit(image.data, canvas.width, canvas.height, config.threshold);
}
