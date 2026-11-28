import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isEffectiveCall, workerRole, type WorkerPi } from '../src/pi/worker-role.ts'
import { escapeControlTokens, escapeToolResultContent, unescapeControlTokens } from '../src/pi/chatml.ts'

// agent-inbox#1085, worker side: the swamp guard's witness events and the ChatML armor on tool output.

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'armor-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const lines = (file: string) => existsSync(file)
  ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  : []

const RAW = '<' + '|im_start|' + '>'
const ESCAPED = '<' + '|~im_start|' + '>'

describe('control-token armor properties (agent-inbox#1085)', () => {
  it('escapes idempotently, inverts exactly, and leaves plain text byte-identical', () => {
    const nasty = `a ${RAW}b\nc ${'<' + '|endoftext|>'} ${'<' + '|tool|>'} ${'<' + '|endoftext|>'}${'<' + '|'} dangling`
    expect(escapeControlTokens(escapeControlTokens(nasty))).toBe(escapeControlTokens(nasty))
    expect(unescapeControlTokens(escapeControlTokens(nasty))).toBe(nasty)
    expect(escapeControlTokens('no tokens: a ~ b |> <| ~ |><|>')).toBe('no tokens: a ~ b |> <| ~ |><|>')
    expect(unescapeControlTokens('a worker\'s own summary, untouched')).toBe('a worker\'s own summary, untouched')
  })

  it('patches a tool_result content the way pi\'s hook expects, and nothing when it has no tokens', () => {
    expect(escapeToolResultContent([{ type: 'text', text: `file says ${RAW}` }]))
      .toEqual({ content: [{ type: 'text', text: `file says ${ESCAPED}` }] })
    expect(escapeToolResultContent('plain output')).toBeUndefined()
    expect(escapeToolResultContent([{ type: 'image', data: 'x' }])).toBeUndefined()
    expect(escapeToolResultContent(undefined)).toBeUndefined()
  })
})

describe('isEffectiveCall: the four effects the swamp guard counts (agent-inbox#1085)', () => {
  it('counts writes, tests, builds, commits and PR opens; not reads, greps, cats', () => {
    expect(isEffectiveCall('write', { path: 'a', content: 'x' })).toBe(true)
    expect(isEffectiveCall('edit', { path: 'a' })).toBe(true)
    expect(isEffectiveCall('bash', { command: 'pytest -q tests/' })).toBe(true)
    expect(isEffectiveCall('bash', { command: 'cd repo && npm test' })).toBe(true)
    expect(isEffectiveCall('bash', { command: 'git commit -m "fix"' })).toBe(true)
    expect(isEffectiveCall('bash', { command: 'gh pr create --title x' })).toBe(true)
    expect(isEffectiveCall('bash', { command: 'pre-commit run --files a.ts' })).toBe(true)
    expect(isEffectiveCall('read', { path: 'a' })).toBe(false)
    expect(isEffectiveCall('bash', { command: 'cat README.md' })).toBe(false)
    expect(isEffectiveCall('bash', { command: 'git log --oneline -3' })).toBe(false)
    expect(isEffectiveCall('bash', { command: 'git commit-tees are fun' })).toBe(false)
  })
})

function fakePi() {
  const handlers = new Map<string, Array<(event?: unknown) => unknown>>()
  const tools: Array<{ name: string; execute: (id: string, args: Record<string, unknown>) => unknown }> = []
  const pi: WorkerPi = {
    registerTool: tool => { tools.push(tool) },
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    sendUserMessage: () => {},
  }
  const emit = (event: string, payload?: unknown) => (handlers.get(event) ?? []).map(h => h(payload))
  const dir = tmp()
  const start = () => workerRole(pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 1000)
  return { pi, emit, dir, start, tools }
}

describe('the worker reports its turns and armors tool output (agent-inbox#1085)', () => {
  it('emits one turn event per settled run: effects counted from tool calls, reasoning quoted when bare', () => {
    const w = fakePi()
    expect(w.start()).toBe(true)
    const assistant = (text: string) => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } })

    w.emit('agent_start')
    w.emit('message_end', assistant('designing a FakeTokenizer subclass for the trailer merge'))
    w.emit('agent_settled')
    const turns = () => lines(join(w.dir, 'events.jsonl')).filter(e => e.type === 'turn')
      .map(({ type, effects, reasoning }) => ({ type, effects, ...(reasoning === undefined ? {} : { reasoning }) }))
    expect(turns()).toEqual([{ type: 'turn', effects: false, reasoning: 'designing a FakeTokenizer subclass for the trailer merge' }])

    w.emit('agent_start')
    w.emit('tool_call', { toolName: 'write', input: { path: 'a.ts' } })
    w.emit('message_end', assistant('writing it now'))
    w.emit('agent_settled')
    expect(turns()[1]).toEqual({ type: 'turn', effects: true })
  })

  it('escapes raw control tokens in tool results, so file bytes cross the boundary armored', () => {
    const w = fakePi()
    w.start()
    const patched = w.emit('tool_result', { toolName: 'read', content: [{ type: 'text', text: `template: ${RAW}system` }] })
    expect(patched[0]).toEqual({ content: [{ type: 'text', text: `template: ${ESCAPED}system` }] })
    const clean = w.emit('tool_result', { toolName: 'read', content: [{ type: 'text', text: 'no tokens here' }] })
    expect(clean[0]).toBeUndefined()
  })
})
