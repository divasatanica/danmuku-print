/**
 * 平台 transport 选择器：只有这里根据 `process.platform` 分支。
 *
 * 渲染和 TSPL 序列化必须与平台无关，两端发送完全相同的字节流。
 */
import { submitRaw as submitMac } from './macos.ts';
import { submitRaw as submitWindows } from './windows.ts';

/** 除平台专属注入项外，两个 transport 共有的提交选项。 */
export interface RawSubmitOptions {
  wait?: boolean;
  timeoutMs?: number;
  title?: string;
}

export type RawTransport = (
  queue: string,
  data: Buffer,
  options?: RawSubmitOptions,
) => Promise<string | number | null>;

export const SUPPORTED_PLATFORMS = ['darwin', 'win32'] as const;

/** 按平台返回 transport；不支持的平台直接抛错，绝不静默回退到 Mock。 */
export function selectTransport(platform: string): RawTransport {
  switch (platform) {
    case 'darwin':
      return submitMac;
    case 'win32':
      return submitWindows;
    default:
      throw new Error(
        `不支持的打印平台 "${platform}"：目前只支持 darwin（macOS，开发调试）`
        + '和 win32（Windows，生产）。',
      );
  }
}

export function isSupportedPlatform(platform: string): boolean {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);
}

/** 当前平台提交 RAW TSPL 字节。 */
export function submitRaw(
  queue: string,
  data: Buffer,
  options?: RawSubmitOptions,
): Promise<string | number | null> {
  return selectTransport(process.platform)(queue, data, options);
}
