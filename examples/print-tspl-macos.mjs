// Print a TSPL test label on macOS through the CUPS queue installed by the
// N31D driver.
//
// The queue normally sends jobs through the vendor's raster filters, which
// would corrupt raw TSPL. `lp -o raw` marks the document as
// application/vnd.cups-raw, so CUPS skips those filters but still uses the
// installed queue and its USB backend.
//
// The N31D firmware used here ignores the TSPL TEXT/BOX commands; the vendor
// driver rasterizes everything into BITMAP blocks. This example does the same:
// it draws the whole label into a 1-bit bitmap and sends one BITMAP command.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LP = '/usr/bin/lp';
const LPSTAT = '/usr/bin/lpstat';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TITLE = 'TSPL test label';

const DPI = 203;
const DEFAULT_WIDTH_MM = 40;
const DEFAULT_HEIGHT_MM = 30;
// This setup prints about 2-3 mm inside the physical left edge, so keep the
// frame away from the right edge of a 40 mm label.
const RIGHT_SAFE_MM = 4;
const BOTTOM_SAFE_MM = 2;

// The vendor filter writes this fixed header before its TSPL commands.
const HPRT_HEADER_BYTES = 512;

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function formatLabelTime(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function mmToDots(mm) {
  return Math.round((mm / 25.4) * DPI);
}

export function formatMm(mm) {
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1);
}

// 5x7 proportional-free font, enough for the ASCII used on the test label.
const FONT_5X7 = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

// Code 39 patterns: nine elements per character, 1 = wide, 0 = narrow.
const CODE39 = {
  0: '000110100', 1: '100100001', 2: '001100001', 3: '101100000',
  4: '000110001', 5: '100110000', 6: '001110000', 7: '000100101',
  8: '100100100', 9: '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001',
  E: '100011000', F: '001011000', G: '000001101', H: '100001100',
  I: '001001100', J: '000011100', K: '100000011', L: '001000011',
  M: '101000010', N: '000010011', O: '100010010', P: '001010010',
  Q: '000000111', R: '100000110', S: '001000110', T: '000010110',
  U: '110000001', V: '011000001', W: '111000000', X: '010010001',
  Y: '110010000', Z: '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100',
  '*': '010010100',
};

function createCanvas(width, height) {
  const rowBytes = Math.ceil(width / 8);
  const data = Buffer.alloc(rowBytes * height, 0xff);

  function setPixel(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    data[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
  }

  function fillRect(x, y, rectWidth, rectHeight) {
    for (let yy = y; yy < y + rectHeight; yy += 1) {
      for (let xx = x; xx < x + rectWidth; xx += 1) setPixel(xx, yy);
    }
  }

  return { width, height, rowBytes, data, setPixel, fillRect };
}

function textWidth(text, scale) {
  return text.length === 0 ? 0 : text.length * 6 * scale - scale;
}

function drawText(canvas, x, y, text, scale = 2) {
  const normalized = text.toUpperCase();
  let cursor = x;
  for (const character of normalized) {
    const glyph = FONT_5X7[character] ?? FONT_5X7[' '];
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row][column] === '1') {
          canvas.fillRect(
            cursor + column * scale,
            y + row * scale,
            scale,
            scale,
          );
        }
      }
    }
    cursor += 6 * scale;
  }
  return cursor - x;
}

function drawCenteredText(canvas, centerX, y, text, scale = 2) {
  const width = textWidth(text, scale);
  return drawText(canvas, Math.round(centerX - width / 2), y, text, scale);
}

function drawCode39(canvas, x, y, text, {
  height = 44,
  narrow = 1,
  wide = 3,
} = {}) {
  const encoded = `*${text.toUpperCase()}*`;
  let cursor = x;
  for (const character of encoded) {
    const pattern = CODE39[character];
    if (!pattern) throw new Error(`Code 39 cannot encode ${JSON.stringify(character)}.`);
    for (let index = 0; index < 9; index += 1) {
      const barWidth = pattern[index] === '1' ? wide : narrow;
      if (index % 2 === 0) canvas.fillRect(cursor, y, barWidth, height);
      cursor += barWidth;
    }
    cursor += narrow;
  }
  return cursor - x - narrow;
}

export function renderTestBitmap({
  widthMm = DEFAULT_WIDTH_MM,
  heightMm = DEFAULT_HEIGHT_MM,
  timestamp = new Date(),
} = {}) {
  if (!(widthMm >= 40 && widthMm <= 80)) {
    throw new RangeError('Label width must be between 40 mm and 80 mm.');
  }
  if (!(heightMm >= 25 && heightMm <= 300)) {
    throw new RangeError('Label height must be between 25 mm and 300 mm.');
  }

  const width = mmToDots(widthMm);
  const height = mmToDots(heightMm);
  const canvas = createCanvas(width, height);
  const contentWidth = width - mmToDots(RIGHT_SAFE_MM);
  const contentHeight = height - mmToDots(BOTTOM_SAFE_MM);
  const centerX = contentWidth / 2;

  // A thin frame makes it obvious whether the label is centred on the media.
  canvas.fillRect(0, 0, contentWidth, 2);
  canvas.fillRect(0, contentHeight - 2, contentWidth, 2);
  canvas.fillRect(0, 0, 2, contentHeight);
  canvas.fillRect(contentWidth - 2, 0, 2, contentHeight);

  drawCenteredText(canvas, centerX, 14, 'TSPL TEST', 3);
  drawCenteredText(canvas, centerX, 44, 'HPRT N31D / MACOS', 2);
  canvas.fillRect(8, 66, contentWidth - 16, 2);

  const barcodeText = 'N31D-TEST';
  const barcodeWidth = (barcodeText.length + 2) * 16 - 1;
  drawCode39(canvas, Math.round(centerX - barcodeWidth / 2), 80, barcodeText, {
    height: 44,
    narrow: 1,
    wide: 3,
  });
  drawCenteredText(canvas, centerX, 130, barcodeText, 2);

  drawCenteredText(canvas, centerX, 154, formatLabelTime(timestamp), 2);
  drawCenteredText(
    canvas,
    centerX,
    180,
    `${formatMm(widthMm)}X${formatMm(heightMm)}MM RAW TSPL`,
    2,
  );

  return canvas;
}

export function makeTestLabel({
  widthMm = DEFAULT_WIDTH_MM,
  heightMm = DEFAULT_HEIGHT_MM,
  timestamp = new Date(),
} = {}) {
  const bitmap = renderTestBitmap({ widthMm, heightMm, timestamp });
  const preamble = Buffer.from([
    `SIZE ${formatMm(widthMm)} mm, ${formatMm(heightMm)} mm`,
    'SET TEAR ON',
    'SET CUTTER OFF',
    'SET PEEL OFF',
    'CLS',
    `BITMAP 0,0,${bitmap.rowBytes},${bitmap.height},1,`,
  ].join('\r\n'), 'ascii');

  return Buffer.concat([
    Buffer.alloc(HPRT_HEADER_BYTES),
    Buffer.from('\r\n', 'ascii'),
    preamble,
    bitmap.data,
    Buffer.from('\r\nPRINT 1,1\r\n', 'ascii'),
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function assertPrinterName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('Provide a CUPS printer queue name.');
  }
  if (/[\0\r\n]/.test(name) || name.startsWith('-')) {
    throw new TypeError(`Invalid CUPS printer queue name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function listPrinters() {
  const result = run(LPSTAT, ['-e']);
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || 'lpstat -e failed.');
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function resolvePrinterName(explicit) {
  if (explicit) return assertPrinterName(explicit);

  const fromEnv = process.env.TSPL_PRINTER;
  if (fromEnv && fromEnv.trim()) return assertPrinterName(fromEnv.trim());

  const result = run(LPSTAT, ['-d']);
  const text = (result.stdout || '').trim();
  // "system default destination: NAME" / "系统默认目的位置：NAME"
  const match = /[:：]\s*(\S+)\s*$/.exec(text);
  if (result.status === 0 && match) return assertPrinterName(match[1]);

  throw new Error(
    'No printer specified and no CUPS default destination. Pass a queue name or '
    + 'set TSPL_PRINTER. Available queues: ' + (listPrinters().join(', ') || '(none)'),
  );
}

export function assertPrinterExists(name) {
  const result = run(LPSTAT, ['-p', name]);
  if (result.status === 0) return;
  throw new Error(
    `CUPS queue "${name}" was not found. Available queues: `
    + (listPrinters().join(', ') || '(none)'),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseJobId(stdout, printerName) {
  // The surrounding message is localized (for example
  // "请求id是HPRT_N31D-1（1个文件）"), so anchor on the queue name instead
  // of whitespace. CUPS queue names are case-insensitive.
  const match = new RegExp(`${escapeRegExp(printerName)}-\\d+`, 'i').exec(stdout);
  return match ? match[0] : null;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(sleepCell, 0, 0, milliseconds);
}

function isJobQueued(jobId, printerName) {
  const result = run(LPSTAT, ['-W', 'not-completed', '-o', printerName]);
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `lpstat failed for queue "${printerName}".`);
  }
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === jobId);
}

export function waitForJob(jobId, printerName, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isJobQueued(jobId, printerName)) return;
    sleepSync(500);
  }
  throw new Error(
    `Job ${jobId} is still queued after ${timeoutMs} ms. Check `
    + `"lpstat -p ${printerName}" and "lpstat -W not-completed -o ${printerName}", `
    + `or cancel it with "cancel ${jobId}".`,
  );
}

export function printRawTspl(printerName, data, {
  wait = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  title = DEFAULT_TITLE,
} = {}) {
  if (process.platform === 'win32') {
    throw new Error('Use examples/print-tspl.mjs on Windows.');
  }
  const name = assertPrinterName(printerName);
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new TypeError('Provide a non-empty Buffer containing TSPL commands.');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('Provide a non-empty job title.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer.');
  }
  assertPrinterExists(name);

  const directory = mkdtempSync(join(tmpdir(), 'tspl-'));
  try {
    const file = join(directory, 'label.bin');
    writeFileSync(file, data, { mode: 0o600 });

    const result = run(LP, [
      '-d', name,
      '-o', 'raw',
      '-n', '1',
      '-t', title,
      '--', file,
    ]);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      const exit = result.status === null ? '' : ` (exit ${result.status})`;
      throw new Error(`lp failed${exit}: ${detail || 'unknown CUPS error'}`);
    }

    const jobId = parseJobId(result.stdout, name);
    if (!jobId) {
      if (wait) {
        console.error(
          'Warning: lp accepted the label but no job ID could be parsed; '
          + `not waiting. lp said: ${result.stdout.trim()}`,
        );
      }
      return null;
    }
    if (wait) waitForJob(jobId, name, timeoutMs);
    return jobId;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function usage() {
  return [
    'Usage: node examples/print-tspl-macos.mjs [queue] [options]',
    '',
    'Options:',
    '  --width <mm>      Label width (default 40)',
    '  --height <mm>     Label height (default 30)',
    '  --dry-run         Write the TSPL bytes instead of printing',
    '  --out <file>      With --dry-run, write the bytes to <file>',
    '  --no-wait         Do not wait for the job to leave the queue',
    '  --timeout <ms>    Wait timeout (default 30000)',
    '  -h, --help        Show this help',
    '',
    'The queue defaults to $TSPL_PRINTER or the CUPS default destination.',
    'List queues with: lpstat -e',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    printer: '',
    widthMm: DEFAULT_WIDTH_MM,
    heightMm: DEFAULT_HEIGHT_MM,
    dryRun: false,
    out: '',
    wait: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-wait') {
      options.wait = false;
    } else if (arg === '--out' || arg === '--timeout' || arg === '--width' || arg === '--height') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === '--out') {
        options.out = value;
      } else if (arg === '--timeout') {
        options.timeoutMs = Number(value);
        if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error('--timeout must be a positive integer.');
        }
      } else {
        const mm = Number(value);
        if (!Number.isFinite(mm) || mm <= 0) {
          throw new Error(`${arg} must be a positive number.`);
        }
        if (arg === '--width') options.widthMm = mm;
        else options.heightMm = mm;
      }
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.printer) {
      throw new Error('Provide at most one printer queue name.');
    } else {
      options.printer = arg;
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      if (options.out && !options.dryRun) {
        throw new Error('--out requires --dry-run.');
      }
      const data = makeTestLabel({
        widthMm: options.widthMm,
        heightMm: options.heightMm,
      });
      if (options.dryRun) {
        if (options.out) {
          writeFileSync(options.out, data, { mode: 0o600 });
          console.error(`Wrote ${data.length} TSPL bytes to ${options.out}`);
        } else {
          process.stdout.write(data);
        }
      } else {
        const printerName = resolvePrinterName(options.printer);
        const jobId = printRawTspl(printerName, data, {
          wait: options.wait,
          timeoutMs: options.timeoutMs,
        });
        console.log(
          `Submitted TSPL test label to ${printerName}`
          + (jobId ? ` as job ${jobId}.` : '.'),
        );
        if (jobId && options.wait) {
          console.log(
            `The job left the queue. Check that one ${formatMm(options.widthMm)} x `
            + `${formatMm(options.heightMm)} mm label was printed.`,
          );
        }
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
