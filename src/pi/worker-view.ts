/** An in-process worker has no window or transcript: this streams what it does to a file the operator can follow. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineLog } from './log.ts'

export interface WorkerViewOptions {
  dir: string
  log: EngineLog
}

export interface WorkerView {
  readonly path: string
  event(event: { type: string } & Record<string, unknown>): void
  close(note: string): void
}

const argsLine = (args: unknown): string => {
  const a = (args ?? {}) as Record<string, unknown>
  const pick = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url
  return (typeof pick === 'string' ? pick : JSON.stringify(args ?? {})).replace(/\s+/g, ' ').slice(0, 240)
}

const resultLine = (result: unknown): string => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
  const text = Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') : String(result ?? '')
  const lines = text.split('\n')
  const first = (lines.find(l => l.trim()) ?? '').trim().slice(0, 200)
  return lines.length > 1 ? `${first} (+${lines.length - 1} lines)` : first
}

export function openWorkerView(options: WorkerViewOptions, worker: {
  ticketId: string; thread: string; title: string; sessionId: string; workspace: string
}): WorkerView {
  mkdirSync(options.dir, { recursive: true })
  const path = join(options.dir, `${worker.ticketId}.log`)
  let buffer = ''
  let timer: NodeJS.Timeout | undefined
  let turns = 0
  let closed = false

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!buffer) return
    try {
      appendFileSync(path, buffer)
    } catch (error) {
      options.log.line('warn', 'worker.view_write_failed', { path, error: String(error).slice(0, 160) })
    }
    buffer = ''
  }
  // Text arrives as dozens of deltas a second per worker: batching keeps the router's event loop free.
  const write = (text: string): void => {
    buffer += text
    if (!timer) { timer = setTimeout(flush, 250); timer.unref() }
  }

  appendFileSync(path, `\n== ${worker.thread} · ${worker.title}\n   session ${worker.sessionId} · ${worker.workspace} · started ${new Date().toISOString()}\n`)

  return {
    path,
    event(event) {
      if (closed) return
      if (event.type === 'turn_start') write(`\n── turn ${++turns} ──\n`)
      else if (event.type === 'message_update') {
        const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        if (update?.type === 'text_delta' && update.delta) write(update.delta)
        else if (update?.type === 'thinking_start') write('\n(thinking…)\n')
      } else if (event.type === 'tool_execution_start') write(`\n⚙ ${String(event.toolName)} ${argsLine(event.args)}\n`)
      else if (event.type === 'tool_execution_end') write(`  ${event.isError ? '✗' : '✓'} ${resultLine(event.result)}\n`)
      else if (event.type === 'agent_settled') write('\n■ settled: waiting for input or its report\n')
    },
    close(note) {
      if (closed) return
      closed = true
      write(`\n== worker ended: ${note} · ${new Date().toISOString()} ==\n`)
      flush()
    },
  }
}
