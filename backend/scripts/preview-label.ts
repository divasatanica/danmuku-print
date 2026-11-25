/**
 * 离线预览：把样例 PrintJob 渲染成 PNG，不需要打印机、CUPS 或 Windows spooler。
 *
 * 用法：
 *   npm run preview:label --workspace backend -- --out /tmp/label.png
 *   npm run preview:label --workspace backend -- --sample long-price --border
 *   npm run preview:label --workspace backend -- --all --out /tmp/labels
 *   npm run preview:label --workspace backend -- --time 2026-11-24T15:24:11+08:00
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderLabel } from '../src/printing/render-label.ts';
import type { LabelRenderOptions } from '../src/printing/render-label.ts';
import type { PrintJob } from '../src/printer.ts';

type SampleName = 'normal' | 'long-nickname' | 'long-price' | 'emoji' | 'empty';

interface Sample {
  job: PrintJob;
  border?: boolean;
}

const timestamp = Date.parse('2026-11-24T15:24:11+08:00');

const SAMPLES: Record<SampleName, Sample> = {
  normal: {
    job: {
      viewerNumber: 12,
      nickname: '小明同学',
      content: '12.5',
      roomId: '123456',
      eventId: 'preview-normal',
      timestamp,
    },
    border: false,
  },
  'long-nickname': {
    job: {
      viewerNumber: 8888,
      nickname: '这是一个特别特别长的观众昵称用来验证缩小字号和省略号',
      content: '1',
      roomId: '123456',
      eventId: 'preview-long-nickname',
      timestamp,
    },
  },
  'long-price': {
    job: {
      viewerNumber: 3,
      nickname: '爱看直播的人',
      content: '8888888888888888888888888888.888888',
      roomId: '123456',
      eventId: 'preview-long-price',
      timestamp,
    },
  },
  emoji: {
    job: {
      viewerNumber: 7,
      nickname: '🎉喜庆观众🎉',
      content: '66.6 😀🚀',
      roomId: '123456',
      eventId: 'preview-emoji',
      timestamp,
    },
    border: true,
  },
  empty: {
    job: {
      viewerNumber: 1,
      nickname: '',
      content: '',
      roomId: '123456',
      eventId: 'preview-empty',
      timestamp,
    },
  },
};

const SAMPLE_NAMES = Object.keys(SAMPLES) as SampleName[];

interface Options {
  out: string;
  samples: SampleName[];
  all: boolean;
  widthMm: number;
  heightMm: number;
  insetMm: number;
  border: boolean | undefined;
  time: number;
  help: boolean;
}

function usage(): string {
  return [
    '用法：node backend/scripts/preview-label.ts [选项]',
    '',
    '选项：',
    '  --out <路径>     输出 PNG 文件；配合 --all 时是输出目录',
    '  --sample <名称>  normal | long-nickname | long-price | emoji | empty',
    '  --all            渲染全部五种样例',
    '  --width <mm>     标签宽度（默认 40）',
    '  --height <mm>    标签高度（默认 30）',
    '  --inset <mm>     内边距（默认 2）',
    '  --border         开启边框',
    '  --no-border      关闭边框（默认）',
    '  --time <时间>    固定时间戳，支持 epoch 毫秒或 ISO 时间',
    '  -h, --help       显示本帮助',
  ].join('\n');
}

function parseTime(value: string): number {
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (Number.isFinite(ms)) return ms;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`--time 无法解析：${JSON.stringify(value)}`);
  return parsed;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 必须是正数，收到 ${JSON.stringify(value)}`);
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    out: '',
    samples: ['normal'],
    all: false,
    widthMm: 40,
    heightMm: 30,
    insetMm: 2,
    border: undefined,
    time: Date.now(),
    help: false,
  };
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} 缺少取值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--all':
        options.all = true;
        break;
      case '--border':
        options.border = true;
        break;
      case '--no-border':
        options.border = false;
        break;
      case '--sample': {
        const value = take(index, arg);
        index += 1;
        if (!SAMPLE_NAMES.includes(value as SampleName)) {
          throw new Error(`未知样例 ${JSON.stringify(value)}，可选：${SAMPLE_NAMES.join('、')}`);
        }
        options.samples = [value as SampleName];
        break;
      }
      case '--out':
        options.out = take(index, arg);
        index += 1;
        break;
      case '--width':
        options.widthMm = positiveNumber(take(index, arg), '--width');
        index += 1;
        break;
      case '--height':
        options.heightMm = positiveNumber(take(index, arg), '--height');
        index += 1;
        break;
      case '--inset':
        options.insetMm = Number(take(index, arg));
        index += 1;
        if (!Number.isFinite(options.insetMm) || options.insetMm < 0) {
          throw new Error('--inset 必须是非负数');
        }
        break;
      case '--time':
        options.time = parseTime(take(index, arg));
        index += 1;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.all) options.samples = SAMPLE_NAMES;
  return options;
}

function renderSample(name: SampleName, options: Options): { bytes: Buffer; width: number; height: number } {
  const sample = SAMPLES[name];
  const label: Partial<LabelRenderOptions> = {
    widthMm: options.widthMm,
    heightMm: options.heightMm,
    insetMm: options.insetMm,
  };
  if (options.border !== undefined) label.border = options.border;
  else if (sample.border !== undefined) label.border = sample.border;

  const job: PrintJob = { ...sample.job, timestamp: options.time };
  const canvas = renderLabel(job, label);
  return { bytes: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.all) {
    const directory = resolve(options.out || 'preview-labels');
    mkdirSync(directory, { recursive: true });
    for (const name of options.samples) {
      const { bytes, width, height } = renderSample(name, options);
      const file = resolve(directory, `${name}.png`);
      writeFileSync(file, bytes);
      console.error(`已写入 ${file}（${width} × ${height}）`);
    }
    return;
  }

  const name = options.samples[0];
  const { bytes, width, height } = renderSample(name, options);
  const out = resolve(options.out || `label-${name}.png`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.error(`已写入 ${out}（${width} × ${height}，样例 ${name}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
