/**
 * 打印适配器。
 *
 * - `MockPrinter`（默认）：只把任务写到终端，不驱动任何打印机，避免开发环境误打印。
 * - `SystemPrinter`：渲染 → 1-bit 位图 → TSPL → 平台 RAW transport。
 *
 * 只有显式设置 `PRINT_BACKEND=system` 且提供 `PRINT_QUEUE` 才会真实出纸。
 */
import type { Bitmap } from './printing/bitmap.ts';
import {
  DEFAULT_LABEL_OPTIONS,
  normalizeLabelOptions,
  renderLabelBitmap,
} from './printing/render-label.ts';
import type { LabelRenderOptions } from './printing/render-label.ts';
import { DEFAULT_HPRT_HEADER_BYTES, makeTspl } from './printing/tspl.ts';
import type { TsplOptions } from './printing/tspl.ts';
import { isSupportedPlatform, submitRaw } from './printing/transport/index.ts';

export interface PrintJob {
  viewerNumber: number;
  nickname: string;
  content: string;
  roomId: string;
  eventId: string;
  timestamp: number;
}

export interface Printer {
  print(job: PrintJob): Promise<void>;
}

export class MockPrinter implements Printer {
  async print(job: PrintJob): Promise<void> {
    const record = JSON.stringify({ type: 'mock-print', ...job }) + '\n';
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(record, (error) => error ? reject(error) : resolve());
    });
  }
}

export interface SubmitOptions {
  wait: boolean;
  timeoutMs: number;
  title: string;
}

export interface SystemPrintSettings {
  queue: string;
  label: LabelRenderOptions;
  headerBytes: number;
  wait: boolean;
  timeoutMs: number;
  title: string;
}

export interface SystemPrinterDeps {
  render?: (job: PrintJob, label: LabelRenderOptions) => Bitmap;
  makeTspl?: (bitmap: Bitmap, options: TsplOptions) => Buffer;
  submit?: (queue: string, data: Buffer, options: SubmitOptions) => Promise<unknown>;
  logger?: (message: string, error: unknown) => void;
}

/** 渲染、序列化、提交三步分离，方便注入假实现做单元测试。 */
export class SystemPrinter implements Printer {
  readonly settings: SystemPrintSettings;
  private readonly render: NonNullable<SystemPrinterDeps['render']>;
  private readonly buildTspl: NonNullable<SystemPrinterDeps['makeTspl']>;
  private readonly submit: NonNullable<SystemPrinterDeps['submit']>;
  private readonly logger: NonNullable<SystemPrinterDeps['logger']>;

  constructor(settings: SystemPrintSettings, deps: SystemPrinterDeps = {}) {
    this.settings = settings;
    this.render = deps.render ?? renderLabelBitmap;
    this.buildTspl = deps.makeTspl ?? makeTspl;
    this.submit = deps.submit ?? submitRaw;
    this.logger = deps.logger ?? ((message, error) => console.error(message, error));
  }

  async print(job: PrintJob): Promise<void> {
    const { queue, label, headerBytes, wait, timeoutMs, title } = this.settings;
    try {
      const bitmap = this.render(job, label);
      const data = this.buildTspl(bitmap, {
        widthMm: label.widthMm,
        heightMm: label.heightMm,
        headerBytes,
      });
      await this.submit(queue, data, { wait, timeoutMs, title });
    } catch (error) {
      this.logger(
        `打印失败：队列 ${queue}，事件 ${job.eventId}，观众 ${job.viewerNumber}，`
        + `弹幕 ${JSON.stringify(job.content.slice(0, 80))}`,
        error,
      );
      throw error;
    }
  }

  /** 启动日志用的一行配置摘要，不包含敏感信息。 */
  describe(): string {
    const { queue, label, headerBytes, timeoutMs } = this.settings;
    return `打印适配器：system 队列=${queue} 标签=${label.widthMm}×${label.heightMm}mm `
      + `内边距=${label.insetMm}mm 边框=${label.border ? '开' : '关'} 时区=${label.timeZone} `
      + `HPRT头=${headerBytes}B 超时=${timeoutMs}ms`;
  }
}

export type Env = Record<string, string | undefined>;

export interface CreatePrinterDeps {
  platform?: string;
}

export interface PrinterCreation {
  printer: Printer;
  summary: string;
}

function envValue(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function numberOption(env: Env, name: string, fallback: number): number {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${name} 必须是数值，收到 ${JSON.stringify(raw)}。`);
  }
  return value;
}

function integerOption(env: Env, name: string, fallback: number): number {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`环境变量 ${name} 必须是整数，收到 ${JSON.stringify(raw)}。`);
  }
  return Number(raw);
}

function booleanOption(env: Env, name: string, fallback: boolean): boolean {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  throw new Error(
    `环境变量 ${name} 只能是 0/1、on/off 或 true/false，收到 ${JSON.stringify(raw)}。`,
  );
}

const LABEL_ENV_HINT = '（PRINT_LABEL_WIDTH_MM / PRINT_LABEL_HEIGHT_MM / '
  + 'PRINT_LABEL_INSET_MM / PRINT_LABEL_BORDER / PRINT_TIME_ZONE）';

function parseLabelOptions(env: Env): LabelRenderOptions {
  const partial = {
    widthMm: numberOption(env, 'PRINT_LABEL_WIDTH_MM', DEFAULT_LABEL_OPTIONS.widthMm),
    heightMm: numberOption(env, 'PRINT_LABEL_HEIGHT_MM', DEFAULT_LABEL_OPTIONS.heightMm),
    insetMm: numberOption(env, 'PRINT_LABEL_INSET_MM', DEFAULT_LABEL_OPTIONS.insetMm),
    border: booleanOption(env, 'PRINT_LABEL_BORDER', DEFAULT_LABEL_OPTIONS.border),
    timeZone: envValue(env, 'PRINT_TIME_ZONE') ?? DEFAULT_LABEL_OPTIONS.timeZone,
  };
  try {
    return normalizeLabelOptions(partial);
  } catch (error) {
    throw new Error(`标签配置无效${LABEL_ENV_HINT}：${(error as Error).message}`, { cause: error });
  }
}

/**
 * 按环境变量构造打印机。
 *
 * 默认 mock；`PRINT_BACKEND=system` 时要求 `PRINT_QUEUE`，并解析标签尺寸、
 * 内边距、边框、时区、HPRT 头长度和等待超时。配置非法时启动即抛错。
 */
export function createPrinterFromEnv(env: Env = process.env, deps: CreatePrinterDeps = {}): PrinterCreation {
  const backend = (envValue(env, 'PRINT_BACKEND') ?? 'mock').toLowerCase();
  if (backend === 'mock') {
    return { printer: new MockPrinter(), summary: '打印适配器：mock（只输出 JSON 到终端，不驱动打印机）' };
  }
  if (backend !== 'system') {
    throw new Error(`环境变量 PRINT_BACKEND 只能是 mock 或 system，收到 ${JSON.stringify(env.PRINT_BACKEND)}。`);
  }

  const platform = deps.platform ?? process.platform;
  if (!isSupportedPlatform(platform)) {
    throw new Error(
      `PRINT_BACKEND=system 不支持当前平台 "${platform}"：只支持 darwin（macOS，开发调试）`
      + '和 win32（Windows，生产）。',
    );
  }

  const queue = envValue(env, 'PRINT_QUEUE');
  if (!queue) throw new Error('PRINT_BACKEND=system 时必须设置 PRINT_QUEUE（打印机队列名）。');
  if (/[\0\r\n]/.test(queue)) throw new Error('PRINT_QUEUE 不能包含 NUL 或换行。');
  if (queue.startsWith('-')) throw new Error('PRINT_QUEUE 不能以 - 开头。');
  if (queue.length > 220) throw new Error('PRINT_QUEUE 最长 220 个字符。');

  const headerBytes = integerOption(env, 'PRINT_HPRT_HEADER_BYTES', DEFAULT_HPRT_HEADER_BYTES);
  if (headerBytes < 0 || headerBytes > 8192) {
    throw new Error(`环境变量 PRINT_HPRT_HEADER_BYTES 必须是 0 到 8192 的整数，收到 ${headerBytes}。`);
  }
  const timeoutMs = integerOption(env, 'PRINT_TIMEOUT_MS', 30_000);
  if (timeoutMs < 100 || timeoutMs > 600_000) {
    throw new Error(`环境变量 PRINT_TIMEOUT_MS 必须是 100 到 600000 的整数，收到 ${timeoutMs}。`);
  }

  const settings: SystemPrintSettings = {
    queue,
    label: parseLabelOptions(env),
    headerBytes,
    // Windows 的 RAW 提交是即时的，这个开关只在 macOS 上生效。
    wait: true,
    timeoutMs,
    title: '弹幕标签',
  };
  const printer = new SystemPrinter(settings);
  return { printer, summary: printer.describe() };
}
