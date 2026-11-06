import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type InboxWriter = (sessionPrefix: string, body: string) => void

/** Delivery for a worker the router did not spawn (adopted workers, the operator's own asks). */
export class SessionInbox {
  constructor(private readonly dir: string,
              private readonly mk: (p: string, opts: { recursive: true }) => void = mkdirSync) {}

  private path(prefix: string): string {
    return join(this.dir, `${prefix}.md`)
  }

  write: InboxWriter = (prefix, body) => {
    const clean = prefix.trim()
    if (!/^[0-9a-f-]{4,}$/i.test(clean)) throw new Error(`session prefix is not a hex id: ${prefix}`)
    if (!existsSync(this.dir)) this.mk(this.dir, { recursive: true })
    appendFileSync(this.path(clean), `---\n${body.trim()}\n`, 'utf8')
  }

  read(prefix: string, afterBytes = 0): { body: string; bytes: number } {
    const p = this.path(prefix)
    if (!existsSync(p)) return { body: '', bytes: afterBytes }
    const all = readFileSync(p, 'utf8')
    return { body: all.slice(afterBytes), bytes: Buffer.byteLength(all, 'utf8') }
  }
}
