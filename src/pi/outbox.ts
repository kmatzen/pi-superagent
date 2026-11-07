/** The write side of the anti-replay rule: a restart posts no answer twice, on any channel. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'

export interface CommentSink {
  /** Whether this sink can address the message on its channel. */
  accepts(message: OutboundMessage): boolean
  /** `retry` means an earlier attempt may have landed before the process died: look before posting again. */
  post(message: OutboundMessage, text: string, retry: boolean): void | Promise<void>
}

export interface OutboxStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}

const KEY = 'outbox'
const KEEP_SENT_MS = 30 * 86_400_000

type Row = { message: OutboundMessage; status: ReplyStatus; at: string; tries?: number }

export class CommentOutbox implements OutboxPort {
  private rows: Record<string, Row>
  private readonly posting = new Set<string>()

  constructor(private readonly sink: CommentSink, private readonly store: OutboxStore,
              private readonly now: () => number = () => Date.now(),
              private readonly maxTries = 12,
              private readonly gaveUp: (message: OutboundMessage, tries: number, error: string) => void = () => {}) {
    this.rows = this.store.get<Record<string, Row>>(KEY) ?? {}
  }

  private persist(): void { this.store.set(KEY, this.rows) }

  /** A failed post stays pending: marking it sent after an exception is success reported out of nothing. A channel
   *  that answers the same way every time (a 404 for a repository this account cannot see) is no transient fault:
   *  past the budget the reply is dropped, and the give-up is said once, out loud. */
  private failed(row: Row, error: unknown): void {
    if (row.tries && row.tries >= this.maxTries) {
      row.status = 'dropped'
      this.gaveUp(row.message, row.tries, String(error).slice(0, 200))
    }
    this.persist()
  }

  send(message: OutboundMessage): void {
    // Idempotent by id: the engine re-runs a command after a crash.
    if (this.rows[message.id]) return
    this.rows[message.id] = { message, status: 'pending', at: new Date().toISOString() }
    this.persist()
  }

  status(id: string): ReplyStatus | undefined { return this.rows[id]?.status }

  withdraw(id: string): void {
    if (this.rows[id]?.status === 'pending') { delete this.rows[id]; this.persist() }
  }

  flush(): number {
    let sent = 0
    // Send-once only has to outlive a restart; a ledger of every message ever posted is just growth.
    for (const [id, row] of Object.entries(this.rows)) {
      if (row.status === 'sent' && Date.parse(row.at) < this.now() - KEEP_SENT_MS) { delete this.rows[id]; this.persist() }
    }
    for (const [id, row] of Object.entries(this.rows)) {
      if (row.status !== 'pending' || this.posting.has(id)) continue
      if (!this.sink.accepts(row.message)) {
        row.status = 'dropped'
        this.persist()
        continue
      }
      try {
        // Counted before the post, so an attempt that dies with the process still counts.
        row.tries = (row.tries ?? 0) + 1
        this.persist()
        const posted = this.sink.post(row.message, row.message.text, row.tries > 1)
        if (posted instanceof Promise) {
          // Sent only once the channel says so; a failed post stays pending for the next flush.
          this.posting.add(id)
          posted.then(() => { row.status = 'sent'; this.persist() }, error => this.failed(row, error)).finally(() => this.posting.delete(id))
          sent++
          continue
        }
        row.status = 'sent'
        this.persist()
        sent++
      } catch (error) {
        this.failed(row, error)
      }
    }
    return sent
  }

  pending(): string[] { return Object.entries(this.rows).filter(([, r]) => r.status === 'pending').map(([id]) => id) }
}
