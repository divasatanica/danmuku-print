/**
 * 纯文本布局：清理控制字符、按字素切分、自动缩小字号、超宽截断加省略号。
 *
 * 这一层不依赖 Canvas：`measure` 由调用方注入，便于单元测试和复用。
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 控制字符、零宽字符和双向控制符统一替换成空格；保留 ZWJ 和变体选择符。 */
const CONTROL_OR_INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/** 按字素切分（emoji 组合、变音符号不会被拆开）。 */
export function graphemes(text: string): string[] {
  if (text === '') return [];
  return Array.from(graphemeSegmenter.segment(text), part => part.segment);
}

/**
 * 清理用户文本：NFC 归一化、控制字符转空格、空白折叠、首尾去空白，并限制
 * 字素数量，避免极端输入拖慢测量。
 */
export function sanitizeText(value: unknown, maxGraphemes = 120): string {
  if (typeof value !== 'string') return '';
  const limit = Number.isInteger(maxGraphemes) && maxGraphemes > 0 ? maxGraphemes : 120;
  const codePointLimit = Math.max(64, limit * 4);
  const codePoints = Array.from(value);
  const capped = codePoints.length > codePointLimit ? codePoints.slice(0, codePointLimit).join('') : value;
  const cleaned = capped
    .normalize('NFC')
    .replace(CONTROL_OR_INVISIBLE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const parts = graphemes(cleaned);
  if (parts.length <= limit) return cleaned;
  return parts.slice(0, limit).join('').trimEnd();
}

/** 测量函数：给定文本和字号，返回像素宽度。 */
export type TextMeasure = (text: string, sizePx: number) => number;

export interface TextFit {
  /** 实际要绘制的文本（可能已截断）。 */
  text: string;
  /** 选中的字号 px。 */
  size: number;
  /** 该文本在选中字号下的像素宽度。 */
  width: number;
  truncated: boolean;
}

export interface LayoutTextOptions {
  maxWidth: number;
  /** 候选字号，从大到小尝试；内部会排序去重。 */
  sizes: readonly number[];
  measure: TextMeasure;
  ellipsis?: string;
}

/**
 * 选择能放进 `maxWidth` 的最大字号；所有字号都放不下时，用最小字号截断并加
 * 省略号。返回的宽度不超过 `maxWidth`（除非连省略号本身都放不下）。
 */
export function layoutText(value: string, options: LayoutTextOptions): TextFit {
  const { maxWidth, measure, ellipsis = '...' } = options;
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    throw new RangeError(`布局宽度必须是正数，收到 ${maxWidth}。`);
  }
  const sizes = [...new Set(options.sizes.filter(size => Number.isFinite(size) && size > 0))]
    .sort((a, b) => b - a);
  if (sizes.length === 0) throw new RangeError('布局至少需要一个正数字号。');

  const text = typeof value === 'string' ? value : '';
  for (const size of sizes) {
    const width = measure(text, size);
    if (width <= maxWidth) return { text, size, width, truncated: false };
  }

  const size = sizes[sizes.length - 1];
  const ellipsisWidth = measure(ellipsis, size);
  if (ellipsisWidth > maxWidth) return { text: '', size, width: 0, truncated: true };

  const parts = graphemes(text);
  for (let count = parts.length - 1; count > 0; count -= 1) {
    const candidate = parts.slice(0, count).join('').trimEnd() + ellipsis;
    const width = measure(candidate, size);
    if (width <= maxWidth) return { text: candidate, size, width, truncated: true };
  }
  return { text: ellipsis, size, width: ellipsisWidth, truncated: true };
}
