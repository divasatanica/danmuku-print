import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/printing/bitmap.ts';
import { normalizeLabelOptions } from '../src/printing/render-label.ts';
import { MockPrinter, SystemPrinter, createPrinterFromEnv } from '../src/printer.ts';
import type { PrintJob, SystemPrintSettings } from '../src/printer.ts';

const SYSTEM_ENV = { PRINT_BACKEND: 'system', PRINT_QUEUE: 'HPRT_N31D' };

function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    viewerNumber: 12,
    nickname: '小明',
    content: '12.5',
    roomId: '123456',
    eventId: 'event-1',
    timestamp: 1_764_000_000_000,
    ...overrides,
  };
}

test('默认使用 MockPrinter，不触发真实打印', () => {
  const { printer, summary } = createPrinterFromEnv({});
  assert.ok(printer instanceof MockPrinter);
  assert.match(summary, /mock/);

  const explicitMock = createPrinterFromEnv({ PRINT_BACKEND: 'mock' });
  assert.ok(explicitMock.printer instanceof MockPrinter);
});

test('PRINT_BACKEND=system 且提供队列时构造 SystemPrinter，默认值正确', () => {
  const { printer, summary } = createPrinterFromEnv(SYSTEM_ENV);
  assert.ok(printer instanceof SystemPrinter);
  const settings = printer.settings;
  assert.equal(settings.queue, 'HPRT_N31D');
  assert.equal(settings.label.widthMm, 40);
  assert.equal(settings.label.heightMm, 30);
  assert.equal(settings.label.insetMm, 2);
  assert.equal(settings.label.border, false);
  assert.equal(settings.label.timeZone, 'Asia/Shanghai');
  assert.equal(settings.headerBytes, 512);
  assert.equal(settings.timeoutMs, 30_000);
  assert.equal(settings.wait, true);
  assert.match(summary, /队列=HPRT_N31D/);
  assert.match(summary, /标签=40×30mm/);
  assert.match(summary, /边框=关/);
});

test('环境变量覆盖尺寸、内边距、边框、时区、HPRT 头和超时', () => {
  const { printer } = createPrinterFromEnv({
    ...SYSTEM_ENV,
    PRINT_LABEL_WIDTH_MM: '50',
    PRINT_LABEL_HEIGHT_MM: '40',
    PRINT_LABEL_INSET_MM: '1.5',
    PRINT_LABEL_BORDER: '1',
    PRINT_TIME_ZONE: 'UTC',
    PRINT_HPRT_HEADER_BYTES: '0',
    PRINT_TIMEOUT_MS: '5000',
  });
  assert.ok(printer instanceof SystemPrinter);
  const settings = printer.settings;
  assert.equal(settings.label.widthMm, 50);
  assert.equal(settings.label.heightMm, 40);
  assert.equal(settings.label.insetMm, 1.5);
  assert.equal(settings.label.border, true);
  assert.equal(settings.label.timeZone, 'UTC');
  assert.equal(settings.headerBytes, 0);
  assert.equal(settings.timeoutMs, 5000);
});

test('布尔值接受常见写法，PRINT_BACKEND 大小写和空白不敏感', () => {
  for (const value of ['1', 'true', 'ON', 'yes']) {
    const { printer } = createPrinterFromEnv({ ...SYSTEM_ENV, PRINT_LABEL_BORDER: value });
    assert.equal((printer as SystemPrinter).settings.label.border, true, value);
  }
  for (const value of ['0', 'false', 'off', 'NO']) {
    const { printer } = createPrinterFromEnv({ ...SYSTEM_ENV, PRINT_LABEL_BORDER: value });
    assert.equal((printer as SystemPrinter).settings.label.border, false, value);
  }
  const { printer } = createPrinterFromEnv({ PRINT_BACKEND: ' SYSTEM ', PRINT_QUEUE: 'Q' });
  assert.ok(printer instanceof SystemPrinter);
});

test('system 模式缺少 PRINT_QUEUE 时启动即报错', () => {
  assert.throws(() => createPrinterFromEnv({ PRINT_BACKEND: 'system' }), /PRINT_QUEUE/);
  assert.throws(() => createPrinterFromEnv({ PRINT_BACKEND: 'system', PRINT_QUEUE: '   ' }), /PRINT_QUEUE/);
});

test('非法队列名在启动阶段被拒绝', () => {
  for (const queue of ['bad\nqueue', 'bad\0queue', '-fake', 'x'.repeat(221)]) {
    assert.throws(() => createPrinterFromEnv({ PRINT_BACKEND: 'system', PRINT_QUEUE: queue }), /PRINT_QUEUE/);
  }
});

test('非法 PRINT_BACKEND 和不支持的平台立即报错', () => {
  assert.throws(() => createPrinterFromEnv({ PRINT_BACKEND: 'printer' }), /PRINT_BACKEND 只能是 mock 或 system/);
  assert.throws(
    () => createPrinterFromEnv({ ...SYSTEM_ENV }, { platform: 'linux' }),
    /不支持当前平台 "linux"/,
  );
});

test('非法数值、时区、边框和头部长度在启动阶段报错', () => {
  const cases: { env: Record<string, string>; pattern: RegExp }[] = [
    { env: { PRINT_LABEL_WIDTH_MM: 'abc' }, pattern: /PRINT_LABEL_WIDTH_MM 必须是数值/ },
    { env: { PRINT_LABEL_WIDTH_MM: '0' }, pattern: /标签配置无效/ },
    { env: { PRINT_LABEL_HEIGHT_MM: '5' }, pattern: /标签配置无效/ },
    { env: { PRINT_LABEL_INSET_MM: '-1' }, pattern: /标签配置无效/ },
    { env: { PRINT_LABEL_INSET_MM: '30' }, pattern: /内容区/ },
    { env: { PRINT_LABEL_BORDER: 'maybe' }, pattern: /PRINT_LABEL_BORDER/ },
    { env: { PRINT_TIME_ZONE: 'Mars/Olympus' }, pattern: /时区无效/ },
    { env: { PRINT_HPRT_HEADER_BYTES: '-1' }, pattern: /PRINT_HPRT_HEADER_BYTES/ },
    { env: { PRINT_HPRT_HEADER_BYTES: '1.5' }, pattern: /PRINT_HPRT_HEADER_BYTES 必须是整数/ },
    { env: { PRINT_HPRT_HEADER_BYTES: '9000' }, pattern: /PRINT_HPRT_HEADER_BYTES/ },
    { env: { PRINT_TIMEOUT_MS: '0' }, pattern: /PRINT_TIMEOUT_MS/ },
    { env: { PRINT_TIMEOUT_MS: '10' }, pattern: /PRINT_TIMEOUT_MS/ },
    { env: { PRINT_TIMEOUT_MS: 'slow' }, pattern: /PRINT_TIMEOUT_MS 必须是整数/ },
  ];
  for (const { env, pattern } of cases) {
    assert.throws(() => createPrinterFromEnv({ ...SYSTEM_ENV, ...env }), pattern, JSON.stringify(env));
  }
});

test('SystemPrinter.print 按顺序渲染、序列化并提交', async () => {
  const label = normalizeLabelOptions();
  const settings: SystemPrintSettings = {
    queue: 'Q',
    label,
    headerBytes: 256,
    wait: true,
    timeoutMs: 1234,
    title: '弹幕标签',
  };
  const calls: unknown[] = [];
  const bitmap: Bitmap = { width: 8, height: 1, rowBytes: 1, data: Buffer.from([0xff]) };
  const printer = new SystemPrinter(settings, {
    render: (received, receivedLabel) => {
      calls.push(['render', received.eventId, receivedLabel.insetMm]);
      return bitmap;
    },
    makeTspl: (received, options) => {
      calls.push(['tspl', received.width, options.widthMm, options.heightMm, options.headerBytes]);
      return Buffer.from('TSPL');
    },
    submit: async (queue, data, options) => {
      calls.push(['submit', queue, data.toString('latin1'), options.wait, options.timeoutMs, options.title]);
      return 1;
    },
  });

  await printer.print(job());

  assert.deepEqual(calls, [
    ['render', 'event-1', 2],
    ['tspl', 8, 40, 30, 256],
    ['submit', 'Q', 'TSPL', true, 1234, '弹幕标签'],
  ]);
});

test('渲染失败会记录事件上下文并把错误抛给 Listener', async () => {
  const settings: SystemPrintSettings = {
    queue: 'Q',
    label: normalizeLabelOptions(),
    headerBytes: 512,
    wait: true,
    timeoutMs: 30_000,
    title: '弹幕标签',
  };
  const logs: string[] = [];
  const printer = new SystemPrinter(settings, {
    render: () => {
      throw new Error('canvas exploded');
    },
    submit: async () => {
      throw new Error('不应提交');
    },
    logger: (message) => logs.push(message),
  });

  await assert.rejects(printer.print(job()), /canvas exploded/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /队列 Q/);
  assert.match(logs[0], /事件 event-1/);
});

test('提交失败同样向上抛出，不吞掉错误', async () => {
  const settings: SystemPrintSettings = {
    queue: 'Q',
    label: normalizeLabelOptions(),
    headerBytes: 512,
    wait: true,
    timeoutMs: 30_000,
    title: '弹幕标签',
  };
  const printer = new SystemPrinter(settings, {
    render: () => ({ width: 8, height: 1, rowBytes: 1, data: Buffer.from([0xff]) }),
    makeTspl: () => Buffer.from('TSPL'),
    submit: async () => {
      throw new Error('spooler rejected');
    },
    logger: () => {},
  });

  await assert.rejects(printer.print(job()), /spooler rejected/);
});

test('SystemPrinter.describe 不包含弹幕内容', () => {
  const { printer } = createPrinterFromEnv(SYSTEM_ENV);
  const summary = (printer as SystemPrinter).describe();
  assert.match(summary, /队列=HPRT_N31D/);
  assert.doesNotMatch(summary, /12\.5/);
});
