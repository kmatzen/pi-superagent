import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HerdrError, herdrCli } from '../src/pi/herdr.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'herdr-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A fake herdr that answers like the real one: JSON results on stdout, JSON errors on stderr with status 1. */
function fakeHerdr() {
  const dir = tmp()
  const bin = join(dir, 'herdr')
  writeFileSync(bin, `#!/bin/bash
echo "$*" >> "${join(dir, 'calls')}"
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1","label":"superagent"}]}}' ;;
  "workspace create") echo '{"result":{"type":"workspace_created","workspace":{"workspace_id":"w2"},"tab":{"tab_id":"w2:t1"},"root_pane":{"pane_id":"w2:p1"}}}' ;;
  "tab create") echo '{"result":{"type":"tab_created","tab":{"tab_id":"w1:t5"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  "agent start") echo '{"result":{"type":"agent_started","agent":{"name":"'"$3"'","pane_id":"w1:p9","agent":"pi","agent_status":"idle"},"argv":[]}}' ;;
  "agent get")
    if [ "$3" = "gone" ]; then echo '{"error":{"code":"agent_not_found","message":"agent target gone not found"}}' >&2; exit 1; fi
    echo '{"result":{"type":"agent_info","agent":{"name":"'"$3"'","pane_id":"w1:p9","agent":"pi","agent_status":"working"}}}' ;;
  "tab close") echo '{"result":{}}' ;;
  *) echo '{"error":{"code":"bad_request","message":"unexpected"}}' >&2; exit 1 ;;
esac
`)
  chmodSync(bin, 0o755)
  return { bin, calls: () => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : [] }
}

describe('the herdr client', () => {
  it('a herdr that stops answering is a timeout, not a launch queue held for good', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-slow-'))
    const bin = join(dir, 'herdr')
    writeFileSync(bin, '#!/bin/bash\nsleep 30\n')
    chmodSync(bin, 0o755)
    const started = Date.now()
    await expect(herdrCli(bin, 200).tabList()).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a tab\'s last lines as plain text, and an unreadable tab as nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-read-'))
    const bin = join(dir, 'herdr')
    writeFileSync(bin, '#!/bin/bash\n[ "$1 $2" = "pane read" ] && [ "$3" = "w1:p2" ] && { printf "Error: boom\\n%% "; exit 0; }\nexit 1\n')
    chmodSync(bin, 0o755)
    expect(await herdrCli(bin).paneRead('w1:p2', 20)).toContain('Error: boom')
    expect(await herdrCli(bin).paneRead('w1:p9', 20)).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a tab with the worker environment and reads the ids herdr returns', async () => {
    const h = fakeHerdr()
    const tab = await herdrCli(h.bin).tabCreate({ workspace: 'w1', cwd: '/w', label: '#1 · do it', env: { PI_SUPERAGENT_ROLE: 'worker' } })
    expect(tab).toEqual({ tabId: 'w1:t5', paneId: 'w1:p9' })
    expect(h.calls()[0]).toBe('tab create --workspace w1 --cwd /w --label #1 · do it --env PI_SUPERAGENT_ROLE=worker --no-focus')
  })

  it('starts pi as a named agent, passing pi its own arguments after --', async () => {
    const h = fakeHerdr()
    const agent = await herdrCli(h.bin).agentStart({ name: 'sa-gh1-ab12', kind: 'pi', pane: 'w1:p9', timeoutMs: 120000, args: ['--session-id', 'abc'] })
    expect(agent).toMatchObject({ name: 'sa-gh1-ab12', pane_id: 'w1:p9', agent_status: 'idle' })
    expect(h.calls()[0]).toBe('agent start sa-gh1-ab12 --kind pi --pane w1:p9 --timeout 120000 -- --session-id abc')
  })

  it('an agent herdr does not know is undefined; any other failure is an error with its code', async () => {
    const h = fakeHerdr()
    const herdr = herdrCli(h.bin)
    expect(await herdr.agentGet('gone')).toBeUndefined()
    expect(await herdr.agentGet('sa-live')).toMatchObject({ agent_status: 'working' })
    await expect(herdr.paneRun('w1:p1', 'ls')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(herdr.paneRun('w1:p1', 'ls')).rejects.toBeInstanceOf(HerdrError)
  })
})
