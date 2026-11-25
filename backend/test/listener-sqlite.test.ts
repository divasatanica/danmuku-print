import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { Listener } from '../src/listener.ts';
import { PrintJobs } from '../src/print-jobs.ts';
import type { Printer, PrintJob } from '../src/printer.ts';
import { Viewers } from '../src/viewers.ts';

async function startListener(t: TestContext, keywords: string, printer: Printer = { async print() {} }) {
  const directory = mkdtempSync(join(tmpdir(), 'danmaku-listener-test-'));
  const path = join(directory, 'test.sqlite');
  const viewers = new Viewers(path);
  const jobs = new PrintJobs(path);
  const database = new DatabaseSync(path, { readOnly: true });
  const source = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let activeListener: Listener | undefined;
  t.after(async () => {
    activeListener?.stop();
    for (const socket of source.clients) socket.terminate();
    const closed = new Promise<void>(resolve => source.close(() => resolve()));
    await Promise.all([activeListener?.drained(), closed]);
    database.close();
    jobs.close();
    viewers.close();
    if (process.env.KEEP_TEST_DB === '1') {
      t.diagnostic(`SQLite: ${path}`);
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await once(source, 'listening');
  const address = source.address();
  assert(address && typeof address === 'object');
  const listener = new Listener(new URL(`ws://127.0.0.1:${address.port}/ws`), viewers, printer, jobs);
  activeListener = listener;
  const connected = once(source, 'connection');
  listener.start(keywords);
  const [socket] = await connected;
  return {
    listener,
    database,
    async send(...events: object[]) {
      for (const event of events) socket.send(JSON.stringify(event));
      // The client processes the preceding messages before replying to the ping.
      const received = once(socket, 'pong');
      socket.ping();
      await received;
    },
  };
}

function chat(id: string, uid: string, content: string) {
  return { id, roomId: '123', type: 'chat', ts: 42, user: { id: uid, nickname: '观众' }, data: { content } };
}

function jobStates(database: DatabaseSync) {
  return database.prepare('SELECT event_id, state FROM print_jobs ORDER BY id')
    .all().map(({ event_id, state }) => [event_id, state]);
}

test('persists keyword matches once per chat and skips unmatched chat', async (t) => {
  const { listener, database, send } = await startListener(t, ' Hello,欢迎，\n 报名 ');
  await send(
    chat('miss', 'first', '晚上好'),
    chat('english', 'second', 'say HELLO!'),
    chat('chinese', 'third', '欢迎来到直播间'),
    chat('multiple', 'fourth', 'HELLO，我要报名'),
    chat('newline', 'fifth', '如何报名'),
  );
  await listener.drained();

  assert.deepEqual(jobStates(database), [
    ['english', 'succeeded'], ['chinese', 'succeeded'], ['multiple', 'succeeded'], ['newline', 'succeeded'],
  ]);
  const unmatchedViewer = database.prepare('SELECT number FROM viewers WHERE uid = ?').get('first');
  assert.equal(unmatchedViewer?.number, 1);
});

test('reserves limited print slots while the printer is busy', async (t) => {
  const gate = Promise.withResolvers<void>();
  const printed: string[] = [];
  const { listener, database, send } = await startListener(t, '报名', {
    async print({ eventId }) {
      printed.push(eventId);
      if (eventId === 'first') await gate.promise;
      if (eventId === 'second') throw new Error('simulated printer failure');
    },
  });

  try {
    listener.setLimit(2);
    await send(
      chat('miss', '1', '晚上好'),
      chat('first', '1', '报名'),
      chat('second', '2', '我来报名'),
      chat('over-limit', '3', '我要报名'),
    );
    assert.equal(listener.status().remaining, 0);
    assert.deepEqual(jobStates(database), [['first', 'printing'], ['second', 'pending']]);
  } finally {
    gate.resolve();
  }

  await listener.drained();
  await send(chat('after-failure', '3', '我要报名'));
  await listener.drained();
  assert.equal(listener.status().remaining, 0);
  assert.deepEqual(jobStates(database), [['first', 'succeeded'], ['second', 'failed']]);
  assert.deepEqual(printed, ['first', 'second']);
});

test('resets the quota and admits more matching chat after clearing it', async (t) => {
  const { listener, database, send } = await startListener(t, '报名');
  listener.setLimit(1);
  await send(chat('initial', '1', '报名'), chat('blocked', '2', '报名'));
  listener.setLimit(1);
  await send(chat('reset', '2', '报名'), chat('blocked-again', '3', '报名'));
  listener.setLimit(null);
  await send(chat('unlimited-1', '3', '报名'), chat('unlimited-2', '4', '报名'));
  await listener.drained();

  assert.equal(listener.status().remaining, null);
  assert.deepEqual(jobStates(database), [
    ['initial', 'succeeded'], ['reset', 'succeeded'], ['unlimited-1', 'succeeded'], ['unlimited-2', 'succeeded'],
  ]);
});

test('prints ordinary matching chat with the original text and a stable viewer number', async (t) => {
  const printed: PrintJob[] = [];
  const { listener, database, send } = await startListener(t, '好', {
    async print(job) { printed.push(job); },
  });
  const uid = '90071992547409931';
  await send(chat('greeting', uid, '主播晚上好！'), chat('follow-up', uid, '今天也很好'));
  await listener.drained();

  const expected = [
    { viewerNumber: 1, nickname: '观众', content: '主播晚上好！', roomId: '123', eventId: 'greeting', timestamp: 42 },
    { viewerNumber: 1, nickname: '观众', content: '今天也很好', roomId: '123', eventId: 'follow-up', timestamp: 42 },
  ];
  const stored = database.prepare(`
    SELECT v.uid, j.viewer_number AS viewerNumber, j.nickname, j.content,
           j.room_id AS roomId, j.event_id AS eventId, j.timestamp, j.state
    FROM print_jobs j JOIN viewers v ON v.number = j.viewer_number
    ORDER BY j.id
  `).all().map(row => ({ ...row }));

  assert.deepEqual(printed, expected);
  assert.deepEqual(stored, expected.map(job => ({ ...job, uid, state: 'succeeded' })));
});

test('prints chat from any room and skips gifts or chat without a valid user', async (t) => {
  const { listener, database, send } = await startListener(t, '报名');
  await send(
    { ...chat('gift', '1', '报名'), type: 'gift' },
    { ...chat('other-room', '2', '报名'), roomId: '321' },
    chat('invalid-user', '0', '报名'),
  );
  await listener.drained();

  assert.deepEqual(jobStates(database), [['other-room', 'succeeded']]);
  assert.equal(database.prepare('SELECT COUNT(*) AS total FROM viewers').get()?.total, 1);
});
