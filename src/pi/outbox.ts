/** The write side of the anti-replay rule: a restart posts no answer twice, on any channel. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'

export interface CommentSink {
  /** Whether this sink can address the message on its channel. */
  accepts(message: OutboundMessage): boolean
  post(message: OutboundMessage, text: string): void | Promise<void>
}

export interface OutboxStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}

const KEY = 'outbox'

export class CommentOutbox implements OutboxPort {
  private rows: Record<string, { message: OutboundMessage; status: ReplyStatus; at: string }>
  private readonly posting = new Set<string>()

  constructor(private readonly sink: CommentSink, private readonly store: OutboxStore,
              private readonly now: () => number = () => Date.now()) {
    this.rows = this.store.get<Record<string, { message: OutboundMessage; status: ReplyStatus; at: string }>>(KEY) ?? {}
  }

  private persist(): void { this.store.set(KEY, this.rows) }

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
    // Send-once only has to cover a restart's window; the ledger of everything ever posted is not a ledger.
    for (const [id, row] of Object.entries(this.rows)) {
      if (row.status === 'sent' && Date.parse(row.at) < this.now() - 30 * 86_400_000) { delete this.rows[id]; this.persist() }
    }
    for (const [id, row] of Object.entries(this.rows)) {
      if (row.status !== 'pending' || this.posting.has(id)) continue
      // Asking only for a card dropped every GitHub reply before it reached a sink that could post it.
      if (!this.sink.accepts(row.message)) {
        row.status = 'dropped'
        this.persist()
        continue
      }
      try {
        const posted = this.sink.post(row.message, row.message.text)
        if (posted instanceof Promise) {
          // Sent only once the channel says so; a failed post stays pending for the next flush.
          this.posting.add(id)
          posted.then(() => { row.status = 'sent'; this.persist() }, () => {}).finally(() => this.posting.delete(id))
          sent++
          continue
        }
        row.status = 'sent'
        this.persist()
        sent++
      } catch {
        // Stays pending: marking it sent after an exception is success reported out of nothing.
        this.persist()
      }
    }
    return sent
  }

  pending(): string[] { return Object.entries(this.rows).filter(([, r]) => r.status === 'pending').map(([id]) => id) }
}

/** A message with nowhere to go is dropped, not silently queued forever. */
