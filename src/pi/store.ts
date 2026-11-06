/** Synchronous because `atomic()` is; an async driver makes the engine's atomicity a comment.
 *  Upstream's SQLite store is not vendored (schema migrations for a deployment we never ran): ADAPTATION.md. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { threadKey, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition, type ThreadRef, latestAssignment }
  from '../core/model.ts'
import type { Repositories } from '../core/ports.ts'

const clone = <T>(value: T): T => structuredClone(value)

// Ticket order is a column, not rowid: ON CONFLICT DO UPDATE keeps the rowid, and list() must match
// MemoryRepositories (insertion order, stable across updates).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS decision_thread ON decision (thread);
CREATE TABLE IF NOT EXISTS trigger_thread (
  thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
  PRIMARY KEY (thread, id)
);
CREATE INDEX IF NOT EXISTS trigger_thread_order ON trigger_thread (thread, at, id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export class SqliteRepositories implements Repositories {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    // synchronous=FULL and 0600 at open: this file holds mandates and the operator's messages.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
    this.db.exec(SCHEMA)
    try { chmodSync(file, 0o600) } catch { /* read-only fs: the first write fails loudly, which is right */ }
  }

  close(): void { this.db.close() }

  /** Nested calls join the outer transaction: a command's writes all roll back, or none. */
  atomic<T>(work: () => T): T {
    if (this.depth++ > 0) {
      try { return work() } finally { this.depth-- }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* driver rolled back on a fatal error */ }
      throw error
    } finally { this.depth-- }
  }

  private row<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    const r = this.db.prepare(sql).get(...params) as { value: string } | undefined
    return r ? JSON.parse(String(r.value)) as T : undefined
  }

  private rows<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return (this.db.prepare(sql).all(...params) as { value: string }[]).map(r => JSON.parse(String(r.value)) as T)
  }

  triggersOfThread(ref: ThreadRef, limit = 200): Trigger[] {
    return this.rows<Trigger>('SELECT t.value FROM trigger_thread tt JOIN trigger t ON t.id = tt.id WHERE tt.thread = ? ORDER BY tt.at, tt.id LIMIT ?',
      threadKey(ref), limit)
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.row<Trigger>('SELECT value FROM trigger WHERE id = ?', id),
    save: (trigger: Trigger): void => {
      this.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, at = excluded.at')
        .run(trigger.id, JSON.stringify(trigger), trigger.at)
      this.db.prepare('DELETE FROM trigger_thread WHERE id = ?').run(trigger.id)
      const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread (thread, id, at, human) VALUES (?,?,?,?)')
      for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
    },
    disposition: (id: string): TriggerDisposition | undefined =>
      this.row<TriggerDisposition>('SELECT value FROM disposition WHERE id = ?', id),
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db.prepare('INSERT INTO disposition (id, value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
        .run(id, JSON.stringify(value))
    },
  }

  readonly threads = {
    get: (key: string): Thread | undefined => this.row<Thread>('SELECT value FROM thread WHERE key = ?', key),
    save: (thread: Thread): void => {
      this.db.prepare('INSERT INTO thread (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(thread.key, JSON.stringify(thread))
    },
    list: (): Thread[] => this.rows<Thread>('SELECT value FROM thread ORDER BY key'),
    active: (): Thread[] => this.threads.list().filter(t => t.pending.length > 0 || t.evaluating !== undefined),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.row<Ticket>('SELECT value FROM ticket WHERE id = ?', id),
    save: (ticket: Ticket): void => {
      // seq is assigned once and never updated: an amended ticket keeps its place, matching Map.set.
      this.db.prepare(`INSERT INTO ticket (id, seq, value)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ticket), ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value`).run(ticket.id, JSON.stringify(ticket))
    },
    list: (): Ticket[] => this.rows<Ticket>('SELECT value FROM ticket ORDER BY seq DESC'),
    open: (): Ticket[] => this.tickets.list().filter(t => !t.ended),
    active: (): Ticket[] => this.tickets.list().filter(t =>
      t.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(t)?.state ?? '')),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.row<Decision>('SELECT value FROM decision WHERE id = ?', id),
    save: (decision: Decision): void => {
      this.db.prepare('INSERT INTO decision (id, thread, value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, thread = excluded.thread')
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    byThread: (key: string): Decision[] => this.rows<Decision>('SELECT value FROM decision WHERE thread = ? ORDER BY rowid', key),
  }

  /** Small durable values: the sources' read positions and the outbox. */
  readonly kv = {
    get: <T>(key: string): T | undefined => this.row<T>('SELECT value FROM kv WHERE key = ?', key),
    set: (key: string, value: unknown): void => {
      this.db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    },
    delete: (key: string): void => { this.db.prepare('DELETE FROM kv WHERE key = ?').run(key) },
  }
}
