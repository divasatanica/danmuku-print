import { DatabaseSync } from 'node:sqlite';
import type { PrintJob } from './printer.ts';

const jobColumns = 'viewer_number, nickname, content, room_id, event_id, timestamp';
const createTable = `
  CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY,
    viewer_number INTEGER NOT NULL,
    nickname TEXT NOT NULL,
    content TEXT NOT NULL,
    room_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'printing', 'succeeded', 'failed', 'cancelled')),
    created_at TEXT,
    retry_of INTEGER UNIQUE REFERENCES print_jobs(id)
  ) STRICT;
`;

export type JobState = 'pending' | 'printing' | 'succeeded' | 'failed' | 'cancelled';
type JobRow = PrintJob & {
  id: number;
  state: JobState;
  createdAt: string | null;
  retryOf: number | null;
  retriedBy: number | null;
};
export type ListedJob = Omit<JobRow, 'state'> & { state: JobState | 'unconfirmed' };
export type JobPage = { jobs: ListedJob[]; nextBefore: number | null };

export class PrintJobs {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
      this.db.exec(createTable);
      const columns = this.db.prepare('PRAGMA table_info(print_jobs)').all();
      if (!columns.some(column => column.name === 'retry_of')) {
        const createdAt = columns.some(column => column.name === 'created_at') ? 'created_at' : 'NULL';
        this.db.exec(`
          ALTER TABLE print_jobs RENAME TO print_jobs_legacy;
          ${createTable}
          INSERT INTO print_jobs (id, ${jobColumns}, state, created_at)
          SELECT id, ${jobColumns}, state, ${createdAt} FROM print_jobs_legacy;
          DROP TABLE print_jobs_legacy;
        `);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS print_jobs_state_id ON print_jobs (state, id);');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  enqueue(job: PrintJob): void {
    this.db.prepare(`
      INSERT INTO print_jobs (viewer_number, nickname, content, room_id, event_id, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(job.viewerNumber, job.nickname, job.content, job.roomId, job.eventId, job.timestamp);
  }

  list(before: number | undefined, limit: number): JobRow[] {
    const query = this.db.prepare(`
      SELECT job.id, job.viewer_number AS viewerNumber, job.nickname, job.content,
             job.room_id AS roomId, job.event_id AS eventId, job.timestamp, job.state,
             job.created_at AS createdAt, job.retry_of AS retryOf, retry.id AS retriedBy
      FROM print_jobs job LEFT JOIN print_jobs retry ON retry.retry_of = job.id
      ${before === undefined ? '' : 'WHERE job.id < ?'}
      ORDER BY job.id DESC LIMIT ?
    `);
    return (before === undefined ? query.all(limit) : query.all(before, limit)) as unknown as JobRow[];
  }

  has(id: number): boolean {
    return this.db.prepare('SELECT 1 FROM print_jobs WHERE id = ?').get(id) !== undefined;
  }

  cancel(id: number): boolean {
    return this.db.prepare("UPDATE print_jobs SET state = 'cancelled' WHERE id = ? AND state = 'pending'")
      .run(id).changes === 1;
  }

  retry(id: number, activeJobId?: number): number | undefined {
    const row = this.db.prepare(`
      INSERT INTO print_jobs (${jobColumns}, created_at, retry_of)
      SELECT ${jobColumns}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), id
      FROM print_jobs WHERE id = ? AND id IS NOT ? AND state <> 'pending'
      ON CONFLICT(retry_of) DO NOTHING
      RETURNING id
    `).get(id, activeJobId ?? null);
    return row?.id as number | undefined;
  }

  count(state: 'pending' | 'printing'): number {
    return this.db.prepare('SELECT COUNT(*) AS total FROM print_jobs WHERE state = ?')
      .get(state)!.total as number;
  }

  claimNext(): { id: number; job: PrintJob } | undefined {
    const row = this.db.prepare(`
      UPDATE print_jobs SET state = 'printing'
      WHERE id = (SELECT id FROM print_jobs WHERE state = 'pending' ORDER BY id LIMIT 1)
      RETURNING id, viewer_number AS viewerNumber, nickname, content,
                room_id AS roomId, event_id AS eventId, timestamp
    `).get() as (PrintJob & { id: number }) | undefined;
    if (!row) return;
    const { id, ...job } = row;
    return { id, job };
  }

  finish(id: number, state: 'succeeded' | 'failed'): void {
    this.db.prepare("UPDATE print_jobs SET state = ? WHERE id = ? AND state = 'printing'").run(state, id);
  }

  close(): void {
    this.db.close();
  }
}
