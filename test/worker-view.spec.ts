import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openLog } from '../src/pi/log.ts'
import { openWorkerView } from '../src/pi/worker-view.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wview-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const worker = { ticketId: 'abcd1234', thread: 'TASK-159', title: 'DO: add the mask mode', sessionId: 's-1', workspace: '/w/abcd1234' }

describe('the in-process worker view', () => {
  it('writes what the worker does: its text, each tool call with its result, and its turns', () => {
    const dir = tmp()
    const view = openWorkerView({ dir, log: openLog(dir) }, worker)
    view.event({ type: 'turn_start' })
    view.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Reading the attention code.' } })
    view.event({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'rg -n "regional" src' } })
    view.event({ type: 'tool_execution_end', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'src/a.py:10: regional\nsrc/b.py:4: regional' }] } })
    view.event({ type: 'agent_settled' })
    view.close('stopped')
    const text = readFileSync(view.path, 'utf8')
    expect(text).toContain('== TASK-159 · DO: add the mask mode')
    expect(text).toContain('── turn 1 ──')
    expect(text).toContain('Reading the attention code.')
    expect(text).toContain('⚙ bash rg -n "regional" src')
    expect(text).toContain('✓ src/a.py:10: regional (+1 lines)')
    expect(text).toContain('== worker ended: stopped')
  })
})
