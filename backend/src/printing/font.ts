/**
 * 标签字体：随包携带的 Noto Sans SC Regular（OFL 1.1）。
 *
 * 自带字体避免 macOS PingFang 与 Windows 微软雅黑的度量差异，保证换行和截断
 * 位置一致。开发时字体在 `backend/assets/fonts/`，构建后复制到
 * `dist/backend/assets/fonts/`。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';

export const LABEL_FONT_FAMILY = 'Noto Sans SC';
export const LABEL_FONT_FILE = 'NotoSansSC-Regular.ttf';

/**
 * 字体族栈：中文使用自带字体，emoji 交给各平台系统 emoji 字体回退。
 * 位图路径里的 emoji 只是装饰，渲染成色块也不影响标签内容。
 */
export const LABEL_FONT_STACK = `"${LABEL_FONT_FAMILY}", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;

const METRICS_PROBE_TEXT = '国Ag';

/** 所有可能存放字体的路径，按优先级排列；同时覆盖源码运行和构建产物。 */
export function labelFontCandidates(): string[] {
  return [
    // dist/backend/printing/font.js → dist/backend/assets/fonts
    fileURLToPath(new URL(`../../assets/fonts/${LABEL_FONT_FILE}`, import.meta.url)),
    // backend/src/printing/font.ts → backend/assets/fonts
    fileURLToPath(new URL(`../../../assets/fonts/${LABEL_FONT_FILE}`, import.meta.url)),
    resolve(process.cwd(), 'backend/assets/fonts', LABEL_FONT_FILE),
  ];
}

export interface FontResolutionDeps {
  exists?: (path: string) => boolean;
}

/** 返回实际存在的字体路径，找不到时报告所有尝试过的路径。 */
export function resolveLabelFontPath(deps: FontResolutionDeps = {}): string {
  const exists = deps.exists ?? existsSync;
  const candidates = labelFontCandidates();
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  throw new Error(
    `找不到标签字体 ${LABEL_FONT_FILE}。已尝试：\n${candidates.map(path => `  - ${path}`).join('\n')}\n`
    + '请确认 backend/assets/fonts/ 中的字体存在，并且构建后已执行 copy-assets。',
  );
}

export interface EnsureFontDeps extends FontResolutionDeps {
  register?: (path: string) => unknown;
}

let registeredFamily: string | null = null;

/**
 * 注册标签字体，返回可用的字体族名。重复调用只注册一次。
 */
export function ensureLabelFont(deps: EnsureFontDeps = {}): string {
  if (registeredFamily) return registeredFamily;
  const path = resolveLabelFontPath(deps);
  const register = deps.register ?? ((fontPath: string) => GlobalFonts.registerFromPath(fontPath));
  let registered: unknown;
  try {
    registered = register(path);
  } catch (error) {
    throw new Error(`无法注册标签字体 ${path}：${(error as Error).message}`, { cause: error });
  }
  if (!registered) throw new Error(`无法注册标签字体 ${path}：字体文件可能已损坏。`);
  registeredFamily = LABEL_FONT_FAMILY;
  return registeredFamily;
}

/** 仅测试使用：清空注册缓存。 */
export function resetLabelFontCache(): void {
  registeredFamily = null;
}

/** 生成 ctx.font 字符串，例如 `36px "Noto Sans SC", ...`。 */
export function labelFontCss(sizePx: number, weight: 'normal' | 'bold' = 'normal'): string {
  if (!Number.isFinite(sizePx) || sizePx <= 0) throw new RangeError(`字号必须是正数，收到 ${sizePx}。`);
  return `${weight === 'bold' ? 'bold ' : ''}${sizePx}px ${LABEL_FONT_STACK}`;
}

/** 用于稳定垂直居中的测量基准文本。 */
export function metricsProbeText(): string {
  return METRICS_PROBE_TEXT;
}
