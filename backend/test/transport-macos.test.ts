import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_JOB_TITLE,
  LP,
  LPSTAT,
  parseJobId,
  submitRaw,
  waitForJob,
} from '../src/printing/transport/macos.ts';
import type { CommandResult, CommandRunner, MacTransportDeps } from '../src/printing/transport/macos.ts';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

interface RecordedCall {
  command: string;
  args: string[];
}

function submitDeps(state: {
  calls?: RecordedCall[];
  files?: { path: string; data: Buffer }[];
  removed?: string[];
  lp?: CommandResult;
  lpstat?: CommandResult[];
  clock?: { value: number };
  sleeps?: number[];
} = {}): MacTransportDeps {
  const calls = state.calls ?? [];
  const files = state.files ?? [];
  const removed = state.removed ?? [];
  const clock = state.clock ?? { value: 0 };
  const sleeps = state.sleeps ?? [];
  let lpstatIndex = 0;
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args });
    if (command === LP) return state.lp ?? result({ stdout: 'request id is Q-1 (1 file(s))' });
    const responses = state.lpstat ?? [result()];
    const response = responses[Math.min(lpstatIndex, responses.length - 1)];
    lpstatIndex += 1;
    return response;
  };
  return {
    run,
    createTempDir: () => '/tmp/fake-label-dir',
    writeFile: (path, data) => files.push({ path, data }),
    removeDir: (directory) => removed.push(directory),
    now: () => clock.value,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.value += milliseconds;
    },
  };
}

test('parseJobId 能解析中英文 lp 输出，任务号锚定队列名', () => {
  assert.equal(parseJobId('request id is HPRT_N31D-12 (1 file(s))', 'HPRT_N31D'), 'HPRT_N31D-12');
  assert.equal(parseJobId('请求 id 是 HPRT_N31D-3（1 个文件）', 'HPRT_N31D'), 'HPRT_N31D-3');
  assert.equal(parseJobId('request id is hprt_n31d-7 (1 file(s))', 'HPRT_N31D'), 'hprt_n31d-7');
  assert.equal(parseJobId('HPRT_N31D-12 已排队', 'Other'), null);
  assert.equal(parseJobId('', 'Q'), null);
  // 队列名里的正则元字符必须转义。
  assert.equal(parseJobId('request id is A.B-4', 'A.B'), 'A.B-4');
});

test('macOS RAW 用 lp -d <queue> -o raw 提交临时文件并清理目录', async () => {
  const files: { path: string; data: Buffer }[] = [];
  const removed: string[] = [];
  const calls: RecordedCall[] = [];
  const deps = submitDeps({
    calls,
    files,
    removed,
    lp: result({ stdout: 'request id is HPRT_N31D-1 (1 file(s))\n' }),
  });
  const data = Buffer.from('\r\nSIZE 40 mm, 30 mm\r\nBITMAP ...\r\nPRINT 1,1\r\n', 'latin1');

  const jobId = await submitRaw('HPRT_N31D', data, { deps });

  assert.equal(jobId, 'HPRT_N31D-1');
  assert.deepEqual(calls[0], {
    command: LP,
    args: ['-d', 'HPRT_N31D', '-o', 'raw', '-n', '1', '-t', DEFAULT_JOB_TITLE, '--', '/tmp/fake-label-dir/label.bin'],
  });
  assert.deepEqual(files, [{ path: '/tmp/fake-label-dir/label.bin', data }]);
  assert.deepEqual(removed, ['/tmp/fake-label-dir']);
});

test('等待队列时轮询 lpstat，任务离开队列后返回', async () => {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  const deps = submitDeps({
    calls,
    sleeps,
    lp: result({ stdout: 'request id is HPRT_N31D-1 (1 file(s))\n' }),
    lpstat: [
      result({ stdout: 'HPRT_N31D-1 user 1024 Mon 01 Jan 2026 10:00:00 AM CST\n' }),
      result({ stdout: 'HPRT_N31D-1 user 1024 Mon 01 Jan 2026 10:00:00 AM CST\n' }),
      result({ stdout: '' }),
    ],
  });

  const jobId = await submitRaw('HPRT_N31D', Buffer.from('x'), { wait: true, deps });

  assert.equal(jobId, 'HPRT_N31D-1');
  assert.deepEqual(sleeps, [500, 500]);
  const lpstatCalls = calls.filter(call => call.command === LPSTAT);
  assert.equal(lpstatCalls.length, 3);
  assert.deepEqual(lpstatCalls[0].args, ['-W', 'not-completed', '-o', 'HPRT_N31D']);
});

test('任务号大小写不同时仍按仍然排队处理，不会提前返回', async () => {
  const sleeps: number[] = [];
  const deps = submitDeps({
    sleeps,
    lp: result({ stdout: 'request id is HPRT_N31D-1 (1 file(s))' }),
    lpstat: [
      result({ stdout: 'hprt_n31d-1 user 1024 Mon 01 Jan 2026\n' }),
      result({ stdout: '' }),
    ],
  });
  // lpstat 用小写队列名，说明任务仍在队列里；必须等到队列清空才返回。
  const jobId = await submitRaw('HPRT_N31D', Buffer.from('x'), { wait: true, timeoutMs: 1000, deps });
  assert.equal(jobId, 'HPRT_N31D-1');
  assert.deepEqual(sleeps, [500]);
});

test('wait=false 时只提交，不查询队列', async () => {
  const calls: RecordedCall[] = [];
  const deps = submitDeps({ calls });
  await submitRaw('Q', Buffer.from('x'), { wait: false, deps });
  assert.equal(calls.filter(call => call.command === LPSTAT).length, 0);
});

test('超时错误包含 lpstat/cancel 排查提示', async () => {
  const deps = submitDeps({
    lpstat: [result({ stdout: 'Q-1 user 1024 Mon 01 Jan 2026\n' })],
  });
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { wait: true, timeoutMs: 1200, deps }),
    (error: Error) => {
      assert.match(error.message, /未离开队列/);
      assert.match(error.message, /lpstat -p Q/);
      assert.match(error.message, /cancel Q-1/);
      return true;
    },
  );
});

test('waitForJob 在任务已结束时立即返回，队列查询失败则抛错', async () => {
  const ok = { run: (() => result({ stdout: '' })) as CommandRunner, sleep: async () => {}, now: () => 0 };
  await assert.doesNotReject(waitForJob('Q-1', 'Q', 1000, ok));

  const broken: CommandRunner = () => result({ status: 1, stderr: 'lpstat: unable to connect to server' });
  await assert.rejects(
    waitForJob('Q-1', 'Q', 1000, { run: broken, sleep: async () => {}, now: () => 0 }),
    /lpstat 查询队列 "Q" 失败/,
  );
});

test('lp 失败时抛错，临时目录仍然被清理', async () => {
  const removed: string[] = [];
  const deps = submitDeps({
    removed,
    lp: result({ status: 5, stdout: '', stderr: 'lp: Destination "Q" does not exist.' }),
  });
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { deps }),
    /lp 提交到队列 "Q" 失败（退出码 5）：lp: Destination "Q" does not exist\./,
  );
  assert.deepEqual(removed, ['/tmp/fake-label-dir']);
});

test('无法解析任务号时返回 null，不误报成功也不等待', async () => {
  const calls: RecordedCall[] = [];
  const deps = submitDeps({ calls, lp: result({ stdout: 'label accepted' }) });
  const jobId = await submitRaw('Q', Buffer.from('x'), { wait: false, deps });
  assert.equal(jobId, null);
  assert.equal(calls.filter(call => call.command === LPSTAT).length, 0);
});

test('非法队列名、空数据和非法超时被拒绝', async () => {
  const deps = submitDeps();
  for (const queue of ['', '  ', 'bad\nqueue', 'bad\0queue', '-oops']) {
    await assert.rejects(submitRaw(queue, Buffer.from('x'), { deps }), TypeError);
  }
  await assert.rejects(submitRaw('Q', Buffer.alloc(0), { deps }), /非空 Buffer/);
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { timeoutMs: 0, deps }),
    /等待超时/,
  );
  await assert.rejects(
    submitRaw('Q', Buffer.from('x'), { timeoutMs: 1.5, deps }),
    /等待超时/,
  );
});
