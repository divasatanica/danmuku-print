import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const printCommand = String.raw`
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

    public static uint Submit(string name, byte[] data)
    {
        IntPtr printer;
        Check(OpenPrinterW(name, out printer, IntPtr.Zero), "OpenPrinterW");
        try
        {
            var document = new DocumentInfo { Name = "TSPL label", DataType = "RAW" };
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
    [RawLabelPrinter]::Submit($env:TSPL_PRINTER_NAME, $inputBytes.ToArray())
} finally {
    $inputBytes.Dispose()
}
`;

export function makeTestLabel() {
  const commands = [
    'SIZE 50 mm,30 mm',
    'GAP 2 mm,0 mm',
    'CLS',
    'TEXT 24,24,"3",0,1,1,"TSPL TEST"',
    'PRINT 1,1',
  ];
  return Buffer.from(commands.join('\r\n') + '\r\n', 'ascii');
}

export function printRawTspl(printerName, data) {
  if (process.platform !== 'win32') {
    throw new Error('RAW printing in this example requires Windows.');
  }
  if (typeof printerName !== 'string' || !printerName.trim() || printerName.includes('\0')) {
    throw new TypeError('Provide the exact Windows printer queue name.');
  }
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new TypeError('Provide a non-empty Buffer containing TSPL commands.');
  }

  // Pass the queue name and print bytes separately from the PowerShell program.
  const powershell = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const encodedCommand = Buffer.from(printCommand, 'utf16le').toString('base64');
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand,
  ], {
    env: { ...process.env, TSPL_PRINTER_NAME: printerName },
    input: data,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  const jobId = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isInteger(jobId) || jobId <= 0) {
    throw new Error(result.stderr.trim() || 'Windows did not return a print job ID.');
  }
  return jobId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const printerName = process.argv[2];
    if (!printerName) throw new Error('Usage: node examples/print-tspl.mjs "Printer queue name"');
    const jobId = printRawTspl(printerName, makeTestLabel());
    console.log('Submitted Windows print job ' + jobId);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
