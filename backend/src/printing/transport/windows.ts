/**
 * Windows RAW transport：PowerShell + winspool.drv（OpenPrinterW /
 * StartDocPrinterW / WritePrinter，datatype = RAW）。
 *
 * 打印字节通过 stdin 传给 PowerShell，不经过命令行参数，也不落临时文件。
 */
import { spawnSync } from 'node:child_process';

export interface SpawnSyncResult {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}

export interface SpawnSyncOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
  encoding?: 'utf8';
  windowsHide?: boolean;
  maxBuffer?: number;
}

export type SpawnSyncLike = (command: string, args: readonly string[], options: SpawnSyncOptions) => SpawnSyncResult;

export interface WindowsTransportDeps {
  spawnSync?: SpawnSyncLike;
  env?: NodeJS.ProcessEnv;
}

export interface WindowsSubmitOptions {
  /** 打印任务名，只作 spooler 显示用。 */
  title?: string;
  deps?: WindowsTransportDeps;
}

export const DEFAULT_DOCUMENT_TITLE = 'Danmaku label';
const MAX_QUEUE_LENGTH = 220;

/**
 * PowerShell 程序本体。队列名和文档名通过环境变量传入，避免把外部字符串拼进
 * C# 代码；位图字节通过 stdin 传入。
 */
export const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class RawLabelPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocumentInfo
    {
        public string Name;
        public string OutputFile;
        public string DataType;
    }

    [DllImport("winspool.drv", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool OpenPrinterW(string name, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint StartDocPrinterW(IntPtr printer, uint level, ref DocumentInfo document);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, byte[] data, uint size, out uint written);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", ExactSpelling = true)]
    private static extern bool AbortPrinter(IntPtr printer);

    [DllImport("winspool.drv", ExactSpelling = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    private static void Check(bool success, string operation)
    {
        if (!success)
        {
            int code = Marshal.GetLastWin32Error();
            throw new Win32Exception(code, operation + " failed (Win32 " + code + ")");
        }
    }

    public static uint Submit(string name, string documentName, byte[] data)
    {
        IntPtr printer;
        Check(OpenPrinterW(name, out printer, IntPtr.Zero), "OpenPrinterW");
        try
        {
            var document = new DocumentInfo { Name = documentName, DataType = "RAW" };
            uint jobId = StartDocPrinterW(printer, 1, ref document);
            Check(jobId != 0, "StartDocPrinterW");
            try
            {
                Check(StartPagePrinter(printer), "StartPagePrinter");
                uint written;
                Check(WritePrinter(printer, data, (uint)data.Length, out written), "WritePrinter");
                if (written != data.Length)
                    throw new InvalidOperationException("Incomplete RAW write: " + written + "/" + data.Length);

                Check(EndPagePrinter(printer), "EndPagePrinter");
                Check(EndDocPrinter(printer), "EndDocPrinter");
                return jobId;
            }
            catch
            {
                AbortPrinter(printer);
                throw;
            }
        }
        finally
        {
            ClosePrinter(printer);
        }
    }
}
'@

$inputBytes = New-Object System.IO.MemoryStream
try {
    [Console]::OpenStandardInput().CopyTo($inputBytes)
    [RawLabelPrinter]::Submit($env:TSPL_PRINTER_NAME, $env:TSPL_DOCUMENT_NAME, $inputBytes.ToArray())
} finally {
    $inputBytes.Dispose()
}
`;

const defaultSpawnSync: SpawnSyncLike = (command, args, options) => spawnSync(command, args, options);

function describeError(result: SpawnSyncResult, fallback: string): string {
  const stderr = String(result.stderr ?? '').trim();
  const stdout = String(result.stdout ?? '').trim();
  const detail = stderr || stdout;
  const exit = result.status === null || result.status === undefined ? '' : `（退出码 ${result.status}）`;
  return `${fallback}${exit}：${detail || '未返回详细错误'}`;
}

export function assertWindowsQueueName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('必须提供 Windows 打印队列名（PRINT_QUEUE）。');
  }
  const name = value.trim();
  if (/[\0\r\n]/.test(name)) throw new TypeError(`打印队列名不能包含 NUL 或换行：${JSON.stringify(value)}。`);
  if (name.length > MAX_QUEUE_LENGTH) throw new TypeError(`打印队列名过长（最多 ${MAX_QUEUE_LENGTH} 字符）。`);
  return name;
}

function assertDocumentTitle(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_DOCUMENT_TITLE;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('打印任务名不能为空。');
  if (/[\0\r\n]/.test(value)) throw new TypeError('打印任务名不能包含 NUL 或换行。');
  return value.trim().slice(0, 120);
}

function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * 提交 RAW 字节到 Windows 打印队列，返回 spooler 分配的任务号。
 *
 * 用 `-EncodedCommand` 传 PowerShell 程序（UTF-16LE + base64），避免引号转义
 * 问题；`windowsHide: true` 不弹控制台窗口。
 */
export async function submitRaw(
  queue: string,
  data: Buffer,
  options: WindowsSubmitOptions = {},
): Promise<number> {
  const name = assertWindowsQueueName(queue);
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new TypeError('打印数据必须是非空 Buffer。');
  }
  const title = assertDocumentTitle(options.title);
  const deps = options.deps ?? {};
  const spawn = deps.spawnSync ?? defaultSpawnSync;
  const baseEnv = deps.env ?? process.env;
  const encodedCommand = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');

  const result = spawn(powershellPath(baseEnv), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedCommand,
  ], {
    env: { ...baseEnv, TSPL_PRINTER_NAME: name, TSPL_DOCUMENT_NAME: title },
    input: data,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(describeError(result, 'PowerShell RAW 提交失败'));

  const output = String(result.stdout ?? '').trim();
  if (!/^\d+$/.test(output)) {
    throw new Error(describeError(result, `Windows 未返回有效的打印任务号（stdout=${JSON.stringify(output)}）`));
  }
  const jobId = Number(output);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error(describeError(result, `Windows 返回的打印任务号无效：${output}`));
  }
  return jobId;
}
