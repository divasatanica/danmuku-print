/**
 * 1-bit 位图与标签几何。
 *
 * 这里只处理宿主端栅格数据，不允许出现平台分支：macOS 和 Windows 必须拿到
 * 完全相同的位图字节。
 */

/** 标签打印机固定 203 dpi，40 × 30 mm 输出 320 × 240 点。 */
export const LABEL_DPI = 203;

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly rowBytes: number;
  /** MSB-first 打包的 1-bit 数据，白色为 1、黑色为 0。 */
  readonly data: Buffer;
}

/** 毫米转打印点。 */
export function mmToDots(mm: number, dpi: number = LABEL_DPI): number {
  if (!Number.isFinite(mm) || mm <= 0) throw new RangeError(`长度必须是正数毫米，收到 ${mm}。`);
  if (!Number.isFinite(dpi) || dpi <= 0) throw new RangeError(`DPI 必须是正数，收到 ${dpi}。`);
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}

/** TSPL 指令里的毫米写法：整数不带小数点，其余最多两位小数。 */
export function formatMm(mm: number): string {
  if (!Number.isFinite(mm) || mm <= 0) throw new RangeError(`标签尺寸必须是正数毫米，收到 ${mm}。`);
  return String(Math.round(mm * 100) / 100);
}

/**
 * 把 RGBA 画布数据打包成 1-bit 位图。
 *
 * 先按透明度合成到白底上，亮度低于 `threshold` 的像素是黑点（位 0），其余是
 * 白点（位 1）。宽度不是 8 的倍数时，每行末尾的补白位保持白色。
 */
export function pack1Bit(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 128,
): Bitmap {
  if (!Number.isInteger(width) || width <= 0) throw new RangeError(`位图宽度无效：${width}。`);
  if (!Number.isInteger(height) || height <= 0) throw new RangeError(`位图高度无效：${height}。`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 254) {
    throw new RangeError(`黑白阈值必须是 1 到 254 的整数，收到 ${threshold}。`);
  }
  const expected = width * height * 4;
  if (rgba.length < expected) {
    throw new RangeError(`RGBA 数据不足：需要 ${expected} 字节，收到 ${rgba.length} 字节。`);
  }

  const rowBytes = Math.ceil(width / 8);
  const data = Buffer.alloc(rowBytes * height, 0xff);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowBytes;
    const pixelOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const index = pixelOffset + x * 4;
      const alpha = rgba[index + 3] / 255;
      // 整数权重换算亮度，避免 128 这种边界值上出现浮点漂移。
      const luma = (299 * rgba[index] + 587 * rgba[index + 1] + 114 * rgba[index + 2]) / 1000;
      const composited = 255 - (255 - luma) * alpha;
      if (composited < threshold) data[rowOffset + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return { width, height, rowBytes, data };
}

/** 读取位图上的一个点，1 表示白、0 表示黑。 */
export function bitmapBit(bitmap: Bitmap, x: number, y: number): 0 | 1 {
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) {
    throw new RangeError(`位图坐标越界：(${x}, ${y}) 不在 ${bitmap.width} × ${bitmap.height} 内。`);
  }
  const byte = bitmap.data[y * bitmap.rowBytes + (x >> 3)];
  return (byte & (0x80 >> (x & 7))) === 0 ? 0 : 1;
}
