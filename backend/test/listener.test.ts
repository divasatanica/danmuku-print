import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Listener } from '../src/listener.ts';
import { PrintJobs } from '../src/print-jobs.ts';
import type { PrintJob } from '../src/printer.ts';
import { Viewers } from '../src/viewers.ts';

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for expected listener state');
}

test('filters chat, applies quota at admission, and drains in order after stop', async (t) => {
  const source = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(source, 'listening');
  const address = source.address();
  assert(address && typeof address === 'object');
  const viewers = new Viewers(':memory:');
  const jobs = new PrintJobs(':memory:');
  const printed: PrintJob[] = [];
  const gate = Promise.withResolvers<void>();
  const listener = new Listener(new URL(`ws://127.0.0.1:${address.port}/ws`), viewers, {
    async print(job) {
      printed.push(job);
      if (job.eventId === '1') await gate.promise;
      if (job.eventId === '2') throw new Error('simulated failure');
    },
  }, jobs, 10);
  t.after(async () => {
    gate.resolve();
    listener.stop();
    for (const socket of source.clients) socket.terminate();
    source.close();
    await listener.drained();
    jobs.close();
    viewers.close();
  });
  const connected = once(source, 'connection');
  listener.start('123', ' Hello,，\n世界 ');
  assert.throws(() => listener.start('321', 'hello'));
  listener.setLimit(2);
  const [socket, request] = await connected;
  assert.equal(request.url, '/ws?roomId=123&types=chat');
  socket.send(JSON.stringify({ type: '__connected', roomId: '123' }));
  await until(() => listener.status().connection === 'connected');
  const chat = (id: string, uid: string, content: string, roomId = '123', type = 'chat') => ({
    id, roomId, type, ts: 42, user: { id: uid, nickname: '观众' }, data: { content },
  });
  const send = (event: object) => socket.send(JSON.stringify(event));
  send(chat('wrong', 'wrong', 'HELLO', '321'));
  send(chat('gift', 'gift', 'hello', '123', 'gift'));
  send(chat('miss', 'first', 'bye'));
  send(chat('1', '90071992547409931', 'say H E L L O'));
  send(chat('2', '90071992547409931', '世界'));
  send(chat('over', 'numbered', 'hello'));
  await until(() => listener.status().queued === 1 && viewers.lookup('numbered') === 3);
  assert.equal(listener.status().remaining, 0);
  assert.deepEqual(printed, [{
    viewerNumber: 2, nickname: '观众', content: 'say H E L L O', roomId: '123', eventId: '1', timestamp: 42,
  }]);

  listener.setLimit(1);
  const reconnected = once(source, 'connection');
  socket.terminate();
  const [replacement, nextRequest] = await reconnected;
  assert.equal(nextRequest.url, request.url);
  assert.equal(listener.status().remaining, 1);
  replacement.send(JSON.stringify(chat('3', 'numbered', 'hello')));
  await until(() => listener.status().remaining === 0);
  listener.setLimit(null);
  replacement.send(JSON.stringify(chat('4', 'first', 'hello')));
  await until(() => listener.status().queued === 3);

  listener.stop();
  assert.equal(listener.status().phase, 'draining');
  assert.throws(() => listener.start('321', 'hello'));
  gate.resolve();
  await until(() => listener.status().phase === 'idle');
  assert.deepEqual(printed.map(({ eventId, viewerNumber }) => [eventId, viewerNumber]),
    [['1', 2], ['2', 2], ['3', 3], ['4', 1]]);
  assert.equal(listener.status().succeeded, 3);
  assert.equal(listener.status().failed, 1);
  assert.equal(viewers.lookup('wrong'), undefined);
  assert.equal(viewers.lookup('gift'), undefined);
  const nextRoom = once(source, 'connection');
  listener.start('321', 'hello');
  assert.equal(listener.status().succeeded, 0);
  const [otherRoom] = await nextRoom;
  listener.setLimit(1);
  otherRoom.send(JSON.stringify(chat('2', 'numbered', 'hello', '321')));
  await until(() => listener.status().failed === 1);
  assert.equal(listener.status().remaining, 0);
  assert.equal(printed.at(-1)?.viewerNumber, 3);
});

test('defaults to whole decimal numbers after removing whitespace', async (t) => {
  const source = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(source, 'listening');
  const address = source.address();
  assert(address && typeof address === 'object');
  const viewers = new Viewers(':memory:');
  const jobs = new PrintJobs(':memory:');
  const printed: string[] = [];
  const listener = new Listener(new URL(`ws://127.0.0.1:${address.port}/ws`), viewers, {
    async print(job) { printed.push(job.content); },
  }, jobs);
  t.after(async () => {
    listener.stop();
    for (const socket of source.clients) socket.terminate();
    source.close();
    await listener.drained();
    jobs.close();
    viewers.close();
  });

  const connected = once(source, 'connection');
  listener.start('123');
  const [socket] = await connected;
  const accepted = ['0', ' 1 2 3 ', '　- 1 2 .\t5 ', '+.5'];
  const rejected = ['', '　 ', '价格 12', '12 元', '1.2.3', '1e3', '0xff', '1,000', 'Infinity', '.'];
  [...accepted, ...rejected].forEach((content, index) => {
    const id = String(index + 1);
    socket.send(JSON.stringify({
      id, roomId: '123', type: 'chat', ts: 42, user: { id, nickname: '观众' }, data: { content },
    }));
  });
  await until(() => viewers.lookup(String(accepted.length + rejected.length)) !== undefined);
  await listener.drained();
  assert.deepEqual(printed, accepted);
});

test('viewer numbers survive reopening and preserve long string UIDs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'danmaku-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'viewers.sqlite');
  const first = new Viewers(database);
  assert.equal(first.numberFor('90071992547409931'), 1);
  assert.equal(first.numberFor('90071992547409932'), 2);
  first.close();
  const reopened = new Viewers(database);
  t.after(() => reopened.close());
  assert.equal(reopened.numberFor('90071992547409931'), 1);
  assert.equal(reopened.numberFor('another'), 3);
});

test('resumes pending prints in order after reopening and preserves unconfirmed prints', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'danmaku-print-'));
  const database = join(directory, 'viewers.sqlite');
  const viewers = new Viewers(database);
  const first = new PrintJobs(database);
  for (const eventId of ['started', 'waiting-1', 'waiting-2']) {
    first.enqueue({ eventId, roomId: '123', viewerNumber: 1, nickname: '观众', content: '打印', timestamp: 42 });
  }
  assert.equal(first.claimNext()?.job.eventId, 'started');
  first.close();

  const reopened = new PrintJobs(database);
  t.after(() => {
    reopened.close();
    viewers.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const printed: string[] = [];
  const listener = new Listener(new URL('ws://127.0.0.1:8757/ws'), viewers, {
    async print(job) { printed.push(job.eventId); },
  }, reopened);
  listener.resumePrints();
  await listener.drained();

  assert.deepEqual(printed, ['waiting-1', 'waiting-2']);
  assert.equal(listener.status().queued, 0);
  assert.equal(listener.status().unconfirmed, 1);
  assert.equal(listener.status().succeeded, 2);
  assert.equal(listener.status().phase, 'idle');
  listener.resumePrints();
  await listener.drained();
  assert.deepEqual(printed, ['waiting-1', 'waiting-2']);
});
