import WebSocket from 'ws';
import type { Printer } from './printer.ts';
import type { PrintJobs } from './print-jobs.ts';
import type { Viewers } from './viewers.ts';

const decimalNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function normalizeMatchText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function parseKeywords(keywordInput: unknown): { input: string; terms: string[] } {
  if (keywordInput !== undefined && typeof keywordInput !== 'string') {
    throw new InputError('关键词必须是文本。');
  }
  const input = keywordInput?.trim() ?? '';
  const terms = input.split(/[,，\r\n]/).map(normalizeMatchText).filter(Boolean);
  if (input.length > 2000) throw new InputError('关键词总长最多 2000 字符。');
  if (input && !terms.length) throw new InputError('请输入有效关键词，或留空以匹配纯数字。');
  return { input, terms };
}

export class InputError extends Error {}
export class StateError extends Error {}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export class Listener {
  private phase: 'idle' | 'listening' | 'draining' = 'idle';
  private connection: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  private keywordInput = '';
  private keywords: string[] = [];
  private limit: number | null = null;
  private remaining: number | null = null;
  private activeJobId: number | undefined;
  private succeeded = 0;
  private failed = 0;
  private connectionError: string | null = null;
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private queue: Promise<void> | undefined;

  private readonly endpoint: URL;
  private readonly viewers: Viewers;
  private readonly printer: Printer;
  private readonly jobs: PrintJobs;
  private readonly reconnectDelay: number;

  constructor(endpoint: URL, viewers: Viewers, printer: Printer, jobs: PrintJobs, reconnectDelay = 2000) {
    this.endpoint = endpoint;
    this.viewers = viewers;
    this.printer = printer;
    this.jobs = jobs;
    this.reconnectDelay = reconnectDelay;
  }

  status() {
    const {
      phase, connection, keywordInput, limit, remaining,
      succeeded, failed, connectionError,
    } = this;
    const printing = this.activeJobId !== undefined;
    const queued = this.jobs.count('pending');
    const unconfirmed = this.jobs.count('printing') - Number(printing);
    return {
      phase, connection, keywords: keywordInput, limit, remaining,
      queued, printing, succeeded, failed, unconfirmed, connectionError,
    };
  }

  start(keywordInput?: unknown): void {
    if (this.phase !== 'idle') throw new StateError('当前任务仍在监听或处理打印队列。');
    const { input, terms } = parseKeywords(keywordInput);

    this.keywordInput = input;
    this.keywords = terms;
    this.limit = this.remaining = null;
    this.succeeded = this.failed = this.reconnectAttempts = 0;
    this.connectionError = null;
    this.phase = 'listening';
    this.connection = 'connecting';
    this.connect();
  }

  setKeywords(keywordInput: unknown): void {
    if (this.phase !== 'listening') throw new StateError('请先开始监听。');
    const { input, terms } = parseKeywords(keywordInput);
    this.keywordInput = input;
    this.keywords = terms;
  }

  setLimit(value: unknown): void {
    if (this.phase !== 'listening') throw new StateError('请先开始监听。');
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      throw new InputError('上限必须为正整数。');
    }
    this.limit = this.remaining = value;
  }

  stop(): void {
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    this.connection = 'disconnected';
    this.connectionError = null;
    this.phase = this.queue ? 'draining' : 'idle';
  }

  async drained(): Promise<void> {
    await this.queue;
  }

  private connect(): void {
    const url = new URL(this.endpoint);
    console.log('url', url);
    url.searchParams.set('types', 'chat');
    const socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
    this.socket = socket;
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) {
        socket.terminate();
        return;
      }
      awaitingPong = true;
      socket.ping();
    }, 25000);
    socket.on('pong', () => { awaitingPong = false; });
    socket.on('message', (payload, binary) => {
      if (this.socket === socket && !binary) this.receive(payload.toString());
    });
    socket.on('error', () => {
      if (this.socket === socket) this.connectionError = '无法连接 DyHub WebSocket。';
    });
    socket.on('close', () => {
      clearInterval(heartbeat);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connection = 'reconnecting';
      const wait = Math.min(30000, this.reconnectDelay * 2 ** Math.min(this.reconnectAttempts++, 4));
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }

  private receive(payload: string): void {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(payload));
    } catch {
      return;
    }
    if (event.type === '__error') {
      this.connectionError = typeof event.error === 'string' ? event.error.slice(0, 500) : 'DyHub 房间连接失败。';
      return;
    }
    if (event.type === '__hello' || event.type === '__connected' || event.type === 'chat') {
      this.connection = 'connected';
      this.connectionError = null;
      this.reconnectAttempts = 0;
    }
    if (event.type !== 'chat') return;

    const user = record(event.user);
    const { content } = record(event.data);
    const { id, ts } = event;
    if (typeof user.id !== 'string' || !user.id.trim() || user.id === '0' ||
        typeof user.nickname !== 'string' || typeof content !== 'string' ||
        typeof id !== 'string' || !id || typeof ts !== 'number' || !Number.isFinite(ts)) return;

    let viewerNumber: number;
    try {
      viewerNumber = this.viewers.numberFor(user.id);
    } catch (error) {
      console.error('无法分配观众编号', error);
      return;
    }
    if (this.remaining === 0) return;
    const text = normalizeMatchText(content);
    const matches = this.keywords.length
      ? this.keywords.some(keyword => text.includes(keyword))
      : decimalNumber.test(text);
    if (!matches) return;

    const roomId = typeof event.roomId === 'string' ? event.roomId : '';
    try {
      this.jobs.enqueue({ viewerNumber, nickname: user.nickname, content, roomId, eventId: id, timestamp: ts });
    } catch (error) {
      console.error('无法保存打印任务', { roomId, eventId: id }, error);
      return;
    }
    if (this.remaining !== null) this.remaining--;
    this.resumePrints();
  }

  currentPrintId(): number | undefined {
    return this.activeJobId;
  }

  resumePrints(): void {
    if (this.queue || this.jobs.count('pending') === 0) return;
    if (this.phase === 'idle') this.phase = 'draining';
    this.queue = Promise.resolve().then(() => this.printPending());
  }

  private async printPending(): Promise<void> {
    try {
      for (let next = this.jobs.claimNext(); next; next = this.jobs.claimNext()) {
        this.activeJobId = next.id;
        let state: 'succeeded' | 'failed' = 'succeeded';
        try {
          await this.printer.print(next.job);
        } catch {
          state = 'failed';
        } finally {
          this.activeJobId = undefined;
        }
        this.jobs.finish(next.id, state);
        this[state]++;
      }
    } finally {
      this.queue = undefined;
      if (this.phase === 'draining') this.phase = 'idle';
    }
  }
}
