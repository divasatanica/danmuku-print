import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PrintJobs } from '../src/print-jobs.ts';

test('adds an enqueue timestamp to new jobs while preserving the legacy queue', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'print-jobs-migration-'));
  const path = join(directory, 'print.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  db.exec(`
    CREATE TABLE print_jobs (
      id INTEGER PRIMARY KEY,
      viewer_number INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      content TEXT NOT NULL,
      room_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      timestamp REAL NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'printing', 'succeeded', 'failed'))
    ) STRICT;
    CREATE INDEX print_jobs_state_id ON print_jobs (state, id);
    INSERT INTO print_jobs VALUES (7, 1, '观众', 'hello', '123', 'old', 42, 'pending');
  `);

  db.close();

  const jobs = new PrintJobs(path);
  try {
    const before = Date.now();
    jobs.enqueue({ viewerNumber: 1, nickname: '观众', content: 'hello', roomId: '123', eventId: 'new', timestamp: 1 });
    const after = Date.now();
    const reader = new DatabaseSync(path, { readOnly: true });
    const rows = reader.prepare('SELECT id, state, timestamp, created_at FROM print_jobs ORDER BY id').all();
    reader.close();
    const [oldJob, newJob] = rows;
    assert.equal(oldJob.id, 7);
    assert.equal(oldJob.state, 'pending');
    assert.equal(oldJob.timestamp, 42);
    assert.equal(oldJob.created_at, null);
    assert.equal(newJob.timestamp, 1);
    assert(typeof newJob.created_at === 'string');
    assert.match(newJob.created_at, /Z$/);
    const createdAt = Date.parse(newJob.created_at);
    assert(createdAt >= before && createdAt <= after);
  } finally {
    jobs.close();
  }

  const reopened = new PrintJobs(path);
  try {
    assert.equal(reopened.claimNext()?.job.eventId, 'old');
    assert.equal(reopened.claimNext()?.job.eventId, 'new');
  } finally {
    reopened.close();
  }
});

test('cancels queued jobs and appends one retry per original attempt', () => {
  const jobs = new PrintJobs(':memory:');
  try {
    const job = { viewerNumber: 1, nickname: '观众', content: '12.5', roomId: '123', eventId: 'a', timestamp: 42 };
    jobs.enqueue(job);
    jobs.enqueue({ ...job, eventId: 'b' });
    jobs.enqueue({ ...job, eventId: 'c' });
    assert.equal(jobs.claimNext()?.id, 1);
    assert.equal(jobs.cancel(1), false);
    assert.equal(jobs.retry(1, 1), undefined);
    assert.equal(jobs.cancel(2), true);
    assert.equal(jobs.cancel(2), false);
    const retryId = jobs.retry(2);
    assert.equal(retryId, 4);
    assert.equal(jobs.retry(2), undefined);
    assert.equal(jobs.retry(3), undefined);
    assert.equal(jobs.claimNext()?.id, 3);
    jobs.finish(3, 'failed');
    assert.equal(jobs.retry(3), 5);
    assert.deepEqual(jobs.claimNext(), { id: 4, job: { ...job, eventId: 'b' } });
    assert.deepEqual(jobs.list(4, 2).map(row => [row.id, row.state, row.retriedBy]),
      [[3, 'failed', 5], [2, 'cancelled', 4]]);
    assert.equal(jobs.retry(1), 6);
    assert.equal(jobs.list(undefined, 1)[0].retryOf, 1);
  } finally {
    jobs.close();
  }
});
