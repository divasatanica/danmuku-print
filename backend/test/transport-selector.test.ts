import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitRaw as submitMac } from '../src/printing/transport/macos.ts';
import { submitRaw as submitWindows } from '../src/printing/transport/windows.ts';
import {
  SUPPORTED_PLATFORMS,
  isSupportedPlatform,
  selectTransport,
} from '../src/printing/transport/index.ts';

test('darwin 使用 lp -o raw', () => {
  assert.equal(selectTransport('darwin'), submitMac);
});

test('win32 使用 winspool RAW', () => {
  assert.equal(selectTransport('win32'), submitWindows);
});

test('不支持的平台抛错而不是静默回退到 Mock', () => {
  for (const platform of ['linux', 'freebsd', 'aix', 'android', '']) {
    assert.throws(() => selectTransport(platform), /不支持的打印平台/);
  }
});

test('平台支持判断与常量一致', () => {
  assert.deepEqual([...SUPPORTED_PLATFORMS], ['darwin', 'win32']);
  assert.equal(isSupportedPlatform('darwin'), true);
  assert.equal(isSupportedPlatform('win32'), true);
  assert.equal(isSupportedPlatform('linux'), false);
});
