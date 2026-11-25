import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DOCUMENT_TITLE,
  POWERSHELL_SCRIPT,
  submitRaw,
} from '../src/printing/transport/windows.ts';
import type {
  SpawnSyncLike,
  SpawnSyncOptions,
  SpawnSyncResult,
} from '../src/printing/transport/windows.ts';

interface Call {
  command: string;
  args: string[];
  options: SpawnSyncOptions;
}

function fakeSpawnSync(result: SpawnSyncResult) {
  const calls: Call[] = [];
  const spawnSync: SpawnSyncLike = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return result;
  };
  return { calls, spawnSync };
}

const success = (stdout = '42\n'): SpawnSyncResult => ({ status: 0, stdout, stderr: '' });

test('Windows RAW 通过 PowerShell -EncodedCommand 提交，stdin 传字节', async () => {
  const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  const { calls, spawnSync } = fakeSpawnSync(success());
  const jobId = await submitRaw('HPRT N31D', data, {
    deps: { spawnSync, env: { SystemRoot: 'C:\\Windows' } },
  });

  assert.equal(jobId, 42);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(call.args.length, 4);

  const script = Buffer.from(call.args[3], 'base64').toString('utf16le');
  assert.match(script, /Add-Type/);
  assert.match(script, /winspool\.drv/);
  assert.match(script, /OpenPrinterW/);
  assert.match(script, /StartDocPrinterW/);
  assert.match(script, /WritePrinter/);
  assert.match(script, /DataType = "RAW"/);
  assert.match(script, /\$env:TSPL_PRINTER_NAME/);

  assert.equal(call.options.env?.TSPL_PRINTER_NAME, 'HPRT N31D');
  assert.equal(call.options.env?.TSPL_DOCUMENT_NAME, DEFAULT_DOCUMENT_TITLE);
  assert.equal(call.options.input, data, '打印字节必须原样通过 stdin 传入');
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.windowsHide, true);
});

test('POWERSHELL_SCRIPT 使用 winspool RAW 而不是写临时文件', () => {
  assert.match(POWERSHELL_SCRIPT, /StartPagePrinter/);
  assert.match(POWERSHELL_SCRIPT, /EndDocPrinter/);
  assert.match(POWERSHELL_SCRIPT, /OpenStandardInput/);
  assert.doesNotMatch(POWERSHELL_SCRIPT, /Out-File|Set-Content|Get-Content/);
});

test('POWERSHELL_SCRIPT 用纯文本报错，并在队列名无效时列出本机队列', () => {
  // -EncodedCommand 下未捕获的错误会被序列化成 CLIXML，Node 端只能读到乱码标签。
  assert.doesNotMatch(POWERSHELL_SCRIPT, /Write-Error/);
  assert.match(POWERSHELL_SCRIPT, /\[Console\]::Error\.WriteLine/);
  assert.match(POWERSHELL_SCRIPT, /exit 1/);
  assert.match(POWERSHELL_SCRIPT, /Win32 1801/);
  assert.match(POWERSHELL_SCRIPT, /EnumPrintersW/);
  assert.match(POWERSHELL_SCRIPT, /LocalQueueNames/);
  assert.match(POWERSHELL_SCRIPT, /ProgressPreference/);
});

test('队列名不存在时错误里带上 PowerShell 给出的候选队列', async () => {
  const hint = 'RAW 打印失败：OpenPrinterW failed (Win32 1801)；队列 HPRT_N31D 不在本机 spooler 里；'
    + '本机队列：HPRT N31D / Fax（Windows 队列名区分空格，例如 "HPRT N31D"）';
  const { spawnSync } = fakeSpawnSync({ status: 1, stdout: '', stderr: `${hint}\n` });
  await assert.rejects(
    submitRaw('HPRT_N31D', Buffer.from('x'), { deps: { spawnSync, env: {} } }),
    (error: Error) => {
      assert.match(error.message, /Win32 1801/);
      assert.match(error.message, /本机队列：HPRT N31D/);
      return true;
    },
  );
});

test('队列名和任务名只通过环境变量传递，队列名去首尾空白', async () => {
  const { calls, spawnSync } = fakeSpawnSync(success('7'));
  await submitRaw('  LabelQueue  ', Buffer.from('x'), {
    title: '  弹幕标签  ',
    deps: { spawnSync, env: { windir: 'D:\\WinNT' } },
  });
  assert.equal(calls[0].command, 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(calls[0].options.env?.TSPL_PRINTER_NAME, 'LabelQueue');
  assert.equal(calls[0].options.env?.TSPL_DOCUMENT_NAME, '弹幕标签');
});

test('非零退出码抛错并附带 stderr', async () => {
  const { spawnSync } = fakeSpawnSync({ status: 1, stdout: '', stderr: 'OpenPrinterW failed (Win32 1801)' });
  await assert.rejects(
    submitRaw('MissingQueue', Buffer.from('x'), { deps: { spawnSync, env: {} } }),
    /OpenPrinterW failed \(Win32 1801\)/,
  );
});

test('stdout 不是正整数任务号时抛错', async () => {
  const { spawnSync } = fakeSpawnSync({ status: 0, stdout: 'submitted ok', stderr: '' });
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { deps: { spawnSync, env: {} } }),
    /任务号/,
  );

  const zero = fakeSpawnSync(success('0'));
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { deps: { spawnSync: zero.spawnSync, env: {} } }),
    /任务号/,
  );
});

test('spawn 本体失败会原样抛出', async () => {
  const error = new Error('powershell not found');
  const { spawnSync } = fakeSpawnSync({ status: null, stdout: '', stderr: '', error });
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { deps: { spawnSync, env: {} } }),
    /powershell not found/,
  );
});

test('非法队列名和空数据在调用 PowerShell 之前就被拒绝', async () => {
  const { calls, spawnSync } = fakeSpawnSync(success());
  for (const queue of ['', '   ', 'bad\nqueue', 'bad\0queue', 'x'.repeat(221)]) {
    await assert.rejects(
      submitRaw(queue, Buffer.from('x'), { deps: { spawnSync, env: {} } }),
      TypeError,
    );
  }
  await assert.rejects(
    submitRaw('Q', Buffer.alloc(0), { deps: { spawnSync, env: {} } }),
    /非空 Buffer/,
  );
  await assert.rejects(
    submitRaw('Q', 'not a buffer' as unknown as Buffer, { deps: { spawnSync, env: {} } }),
    /非空 Buffer/,
  );
  assert.equal(calls.length, 0);
});
