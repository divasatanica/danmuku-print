import { DatabaseSync } from 'node:sqlite';

export class Viewers {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS viewers (
        number INTEGER PRIMARY KEY,
        uid TEXT NOT NULL UNIQUE
      ) STRICT
    `);
  }

  lookup(uid: string): number | undefined {
    const row = this.db.prepare('SELECT number FROM viewers WHERE uid = ?').get(uid);
    return row?.number as number | undefined;
  }

  numberFor(uid: string): number {
    const existing = this.lookup(uid);
    if (existing !== undefined) return existing;
    this.db.prepare('INSERT INTO viewers (uid) VALUES (?) ON CONFLICT(uid) DO NOTHING').run(uid);
    return this.lookup(uid)!;
  }

  close(): void {
    this.db.close();
  }
}
