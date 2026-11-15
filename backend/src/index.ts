import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, Listener, StateError, record } from './listener.ts';
import { PrintJobs } from './print-jobs.ts';
import type { JobPage } from './print-jobs.ts';
import { MockPrinter } from './printer.ts';
import { Viewers } from './viewers.ts';

function localPort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} 无效`);
  return port;
}

const dev = process.argv.includes('--dev');
const port = localPort('PRINT_PORT', dev ? 8759 : 8758);
const origin = `http://127.0.0.1:${port}`;
const devOrigin = dev ? `http://127.0.0.1:${localPort('PRINT_WEB_PORT', 5173)}` : undefined;
const dyhub = new URL(process.env.DYHUB_URL ?? 'http://127.0.0.1:8757');
if (!['http:', 'https:'].includes(dyhub.protocol) || dyhub.username || dyhub.password) {
  throw new Error('DYHUB_URL 必须为无凭据的 HTTP 或 HTTPS 地址');
}
const endpoint = new URL('/ws', dyhub);
endpoint.protocol = dyhub.protocol === 'https:' ? 'wss:' : 'ws:';
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultDatabase = dev ? 'backend/data/viewers.dev.sqlite' : 'backend/data/viewers.sqlite';
const database = resolve(workspaceRoot, process.env.PRINT_DB ?? defaultDatabase);
const assets = new Map<string, { mime: string; data: Buffer }>();
if (!dev) {
  const html = { mime: 'text/html; charset=utf-8', data: readFileSync(new URL('../frontend/index.html', import.meta.url)) };
  assets.set('/', html);
  assets.set('/jobs', html);
  assets.set('/app.js', {
    mime: 'text/javascript; charset=utf-8',
    data: readFileSync(new URL('../frontend/app.js', import.meta.url)),
  });
  assets.set('/style.css', {
    mime: 'text/css; charset=utf-8',
    data: readFileSync(new URL('../frontend/style.css', import.meta.url)),
  });
}
mkdirSync(dirname(database), { recursive: true });
const viewers = new Viewers(database);
const jobs = new PrintJobs(database);
const listener = new Listener(endpoint, viewers, new MockPrinter(), jobs);

function json(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 16_384) {
      request.resume();
      throw new InputError('请求内容过长。');
    }
    chunks.push(chunk);
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new InputError('请求必须是有效的 JSON。');
  }
}

function status() {
  return { ...listener.status(), dyhubUrl: dyhub.href };
}

function positiveId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) throw new InputError('任务编号无效。');
  return id;
}

function jobPage(query: string): JobPage {
  const cursor = new URLSearchParams(query).get('before');
  const pageSize = 25;
  const rows = jobs.list(cursor === null ? undefined : positiveId(cursor), pageSize + 1);
  const active = listener.currentPrintId();
  const page = rows.slice(0, pageSize);
  return {
    jobs: page.map(job => ({
      ...job,
      state: job.state === 'printing' && job.id !== active ? 'unconfirmed' : job.state,
    })),
    nextBefore: rows.length > pageSize ? page.at(-1)!.id : null,
  };
}

let shuttingDown = false;
async function handle(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (request.headers.host !== `127.0.0.1:${port}`) {
    return json(response, 403, { error: '请使用控制台的本地地址访问。' });
  }
  const [path, query = ''] = (request.url ?? '').split('?', 2);
  if (request.method === 'GET') {
    const asset = assets.get(path === '/jobs/' ? '/jobs' : path);
    if (asset) {
      response.writeHead(200, { 'Content-Type': asset.mime });
      response.end(asset.data);
      return;
    }
    if (request.url === '/api/status') return json(response, 200, status());
    if (path === '/api/jobs') return json(response, 200, jobPage(query));
  }
  const jobAction = /^\/api\/jobs\/([^/]+)\/(retry|cancel)$/.exec(path);
  if (request.method === 'POST' && (jobAction || ['/api/start', '/api/stop', '/api/limit'].includes(path))) {
    if (request.headers.origin !== undefined && request.headers.origin !== origin && request.headers.origin !== devOrigin) {
      return json(response, 403, { error: '请从打印控制台提交操作。' });
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return json(response, 415, { error: '请求类型必须是 application/json。' });
    }
    const input = await body(request);
    if (shuttingDown) return json(response, 503, { error: '服务正在停止。' });

    if (jobAction) {
      const id = positiveId(jobAction[1]);
      if (!jobs.has(id)) return json(response, 404, { error: '打印任务不存在。' });
      if (jobAction[2] === 'cancel') {
        if (!jobs.cancel(id)) throw new StateError('只有排队中的任务可以取消。');
        return json(response, 200, { id });
      }
      const retryId = jobs.retry(id, listener.currentPrintId());
      if (retryId === undefined) throw new StateError('任务正在排队、打印，或已有重跑记录。');
      listener.resumePrints();
      return json(response, 201, { id: retryId });
    }

    switch (path) {
      case '/api/start': listener.start(input.roomId, input.keywords); break;
      case '/api/stop': listener.stop(); break;
      case '/api/limit': listener.setLimit(input.limit); break;
    }
    return json(response, 200, status());
  }
  json(response, 404, { error: '路径不存在。' });
}

const server = createServer({ requestTimeout: 15000 }, (request, response) => {
  void handle(request, response).catch((error: unknown) => {
    if (error instanceof InputError) return json(response, 400, { error: error.message });
    if (error instanceof StateError) return json(response, 409, { error: error.message });
    console.error(error);
    json(response, 500, { error: '服务处理请求失败。' });
  });
});
server.listen(port, '127.0.0.1', () => {
  const unconfirmed = jobs.count('printing');
  if (unconfirmed) console.warn(`有 ${unconfirmed} 条打印任务的结果待确认。`);
  listener.resumePrints();
  console.log(dev ? `打印 API ${origin} · 开发控制台 ${devOrigin}` : `打印控制台 ${origin}`);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  listener.stop();
  await listener.drained();
  jobs.close();
  viewers.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
