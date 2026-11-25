/**
 * macOS RAW transport：把 TSPL 字节写进临时文件，再交给 CUPS 的 `lp -o raw`。
 *
 * 队列本身仍走厂商驱动安装好的 USB 后端，但 `-o raw` 让 CUPS 跳过驱动的栅格
 * 滤镜，避免 TSPL 被二次包装。提交和轮询是阻塞式 CLI 调用，等待队列用异步
 * 定时器，不阻塞 HTTP API。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LP = '/usr/bin/lp';
export const LPSTAT = '/usr/bin/lpstat';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_TITLE = 'Danmaku label';
export const POLL_INTERVAL_MS = 500;

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface MacTransportDeps {
  run?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  createTempDir?: () => string;
  removeDir?: (directory: string) => void;
  writeFile?: (path: string, data: Buffer) => void;
}

export interface MacSubmitOptions {
  /** 等待任务离开队列，默认 true。 */
  wait?: boolean;
  timeoutMs?: number;
  title?: string;
  deps?: MacTransportDeps;
}

const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export function assertMacQueueName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('必须提供 CUPS 队列名（PRINT_QUEUE）。');
  }
  const name = value.trim();
  if (/[\0\r\n]/.test(name)) throw new TypeError(`CUPS 队列名不能包含 NUL 或换行：${JSON.stringify(value)}。`);
  if (name.startsWith('-')) throw new TypeError(`CUPS 队列名不能以 - 开头：${JSON.stringify(name)}。`);
  return name;
}

function assertJobTitle(value: unknown): string {
  const title = value === undefined || value === null ? DEFAULT_JOB_TITLE : value;
  if (typeof title !== 'string' || !title.trim()) throw new TypeError('打印任务名不能为空。');
  if (/[\0\r\n]/.test(title)) throw new TypeError('打印任务名不能包含 NUL 或换行。');
  return title.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 `lp` 输出里解析任务号。提示语会随系统语言变化（例如
 * “请求 id 是 HPRT_N31D-12（1 个文件）”），所以用队列名做锚点。
 */
export function parseJobId(stdout: string, queue: string): string | null {
  const match = new RegExp(`${escapeRegExp(queue)}-\\d+`, 'i').exec(stdout);
  return match ? match[0] : null;
}

function isQueued(stdout: string, jobId: string): boolean {
  // CUPS 队列名大小写不敏感，lp 与 lpstat 的大小写可能不一致。
  const target = jobId.toLowerCase();
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => line.split(/\s+/)[0].toLowerCase() === target);
}

interface WaitDeps {
  run: CommandRunner;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

/** 轮询 `lpstat -W not-completed`，直到任务离开队列或超时。 */
export async function waitForJob(
  jobId: string,
  queue: string,
  timeoutMs: number,
  deps: WaitDeps,
): Promise<void> {
  const { run, sleep, now } = deps;
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = run(LPSTAT, ['-W', 'not-completed', '-o', queue]);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(`lpstat 查询队列 "${queue}" 失败：${detail || `退出码 ${result.status}`}。`);
    }
    if (!isQueued(result.stdout, jobId)) return;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
  throw new Error(
    `任务 ${jobId} 在 ${timeoutMs} ms 后仍未离开队列。请检查 `
    + `"lpstat -p ${queue}" 和 "lpstat -W not-completed -o ${queue}"，`
    + `或执行 "cancel ${jobId}" 取消任务。`,
  );
}

/**
 * 提交 RAW TSPL 字节到 CUPS 队列，返回任务号；`lp` 输出无法解析时返回 null。
 */
export async function submitRaw(
  queue: string,
  data: Buffer,
  options: MacSubmitOptions = {},
): Promise<string | null> {
  const name = assertMacQueueName(queue);
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new TypeError('打印数据必须是非空 Buffer。');
  }
  const title = assertJobTitle(options.title);
  const wait = options.wait ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`等待超时必须是正整数毫秒，收到 ${timeoutMs}。`);
  }

  const deps = options.deps ?? {};
  const run = deps.run ?? defaultRunner;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const createTempDir = deps.createTempDir ?? (() => mkdtempSync(join(tmpdir(), 'danmaku-label-')));
  const removeDir = deps.removeDir ?? ((directory: string) => rmSync(directory, { recursive: true, force: true }));
  const writeFile = deps.writeFile
    ?? ((path: string, bytes: Buffer) => writeFileSync(path, bytes, { mode: 0o600 }));

  const directory = createTempDir();
  try {
    const file = join(directory, 'label.bin');
    writeFile(file, data);

    const result = run(LP, ['-d', name, '-o', 'raw', '-n', '1', '-t', title, '--', file]);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      const exit = result.status === null ? '' : `（退出码 ${result.status}）`;
      throw new Error(`lp 提交到队列 "${name}" 失败${exit}：${detail || 'CUPS 返回未知错误'}。`);
    }

    const jobId = parseJobId(result.stdout, name);
    if (!jobId) {
      if (wait) {
        console.warn(`lp 已接受标签，但未能解析任务号，跳过等待。lp 输出：${result.stdout.trim()}`);
      }
      return null;
    }
    if (wait) await waitForJob(jobId, name, timeoutMs, { run, sleep, now });
    return jobId;
  } finally {
    removeDir(directory);
  }
}
