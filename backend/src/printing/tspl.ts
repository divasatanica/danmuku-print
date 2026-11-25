/**
 * TSPL 序列化：只使用 SIZE + BITMAP + PRINT，不使用 TEXT/BOX，因为目标机型
 * （HPRT N31D）固件会忽略矢量文字和矩形指令。
 */
import { formatMm } from './bitmap.ts';
import type { Bitmap } from './bitmap.ts';

/** HPRT 驱动在 TSPL 前写入的固定 512 字节头。Windows 上可用配置关掉。 */
export const DEFAULT_HPRT_HEADER_BYTES = 512;
const MAX_HEADER_BYTES = 8192;

export interface TsplOptions {
  widthMm: number;
  heightMm: number;
  /** 前置零字节头长度，默认 512；设为 0 时不写。 */
  headerBytes?: number;
  /** 默认 ON。 */
  tear?: boolean;
  /** 默认 OFF。 */
  cutter?: boolean;
  /** 默认 OFF。 */
  peel?: boolean;
  copies?: number;
}

/**
 * 组装完整的 TSPL 字节流。
 *
 * 结构：`<headerBytes 个零字节>`、CRLF、`SIZE`/`SET`/`CLS`/`BITMAP` 指令、
 * 紧随其后的位图数据（`BITMAP ... ,1,` 后不允许有 CRLF）、`\r\nPRINT 1,1\r\n`。
 */
export function makeTspl(bitmap: Bitmap, options: TsplOptions): Buffer {
  const headerBytes = options.headerBytes ?? DEFAULT_HPRT_HEADER_BYTES;
  if (!Number.isInteger(headerBytes) || headerBytes < 0 || headerBytes > MAX_HEADER_BYTES) {
    throw new RangeError(`HPRT 头长度必须是 0 到 ${MAX_HEADER_BYTES} 的整数，收到 ${headerBytes}。`);
  }
  const copies = options.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
    throw new RangeError(`打印份数必须是 1 到 100 的整数，收到 ${copies}。`);
  }

  const commands = [
    `SIZE ${formatMm(options.widthMm)} mm, ${formatMm(options.heightMm)} mm`,
    `SET TEAR ${options.tear === false ? 'OFF' : 'ON'}`,
    `SET CUTTER ${options.cutter === true ? 'ON' : 'OFF'}`,
    `SET PEEL ${options.peel === true ? 'ON' : 'OFF'}`,
    'CLS',
    `BITMAP 0,0,${bitmap.rowBytes},${bitmap.height},1,`,
  ].join('\r\n');

  return Buffer.concat([
    Buffer.alloc(headerBytes),
    Buffer.from('\r\n', 'ascii'),
    Buffer.from(commands, 'ascii'),
    bitmap.data,
    Buffer.from(`\r\nPRINT ${copies},1\r\n`, 'ascii'),
  ]);
}
