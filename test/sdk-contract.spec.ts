import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { installedPiVersion, probeSdk } from '../src/pi/sdk-contract.ts'

function installedSdkPath(): string | null {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = join(root, '@earendil-works/pi-coding-agent/dist/index.js')
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

const sdkPath = installedSdkPath()

const skipWithoutPi = !sdkPath

it('the installed pi exports exactly the surface the worker launcher uses', async () => {
  if (skipWithoutPi) return
  const sdk = await import(sdkPath!)
  expect(probeSdk(sdk, installedPiVersion(sdkPath!))).toEqual({ ok: true, version: expect.any(String), problems: [] })
}, 60_000)

it('a session from the installed pi carries the members the launcher drives', async () => {
  if (skipWithoutPi) return
  const sdk = await import(sdkPath!)
  const created = await sdk.createAgentSession({
    cwd: process.cwd(),
    sessionManager: sdk.SessionManager.inMemory(process.cwd()),
  })
  expect(typeof created.session).toBe('object')
  for (const member of ['sessionId', 'prompt', 'subscribe', 'abort', 'dispose'] as const) {
    expect(created.session[member], `session.${member}`).toBeDefined()
  }
  created.session.dispose()
}, 60_000)

function piOnPath(): string | null {
  try {
    return execFileSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

it("inside pi, the router's loadSdk gets the running pi's own SDK, wherever pi is installed", () => {
  const pi = piOnPath()
  if (!pi) return
  const dir = mkdtempSync(join(tmpdir(), 'sa-sdk-'))
  try {
    const result = join(dir, 'result.json')
    writeFileSync(join(dir, 'probe.ts'), [
      "import { writeFileSync } from 'node:fs'",
      "import * as host from '@earendil-works/pi-coding-agent'",
      `import { loadSdk } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'pi', 'router.ts'))}`,
      'export default async function probe() {',
      '  const sdk = await loadSdk({})',
      `  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ same: sdk.createAgentSession === host.createAgentSession }))`,
      '}',
    ].join('\n'))
    // No extensions but the probe, no network, no session file: stdin closes and pi exits after loading.
    execFileSync(pi, ['-ne', '--offline', '--no-session', '-e', join(dir, 'probe.ts'), '--mode', 'rpc'], { input: '', timeout: 60_000 })
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ same: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)

it('a pi on an unsupported major stops the engine from claiming it is ready', () => {
  const sdk = { createAgentSession: async () => ({}), SessionManager: { inMemory: () => ({}) }, DefaultResourceLoader: class {}, getAgentDir: () => '/a' }
  expect(probeSdk(sdk, '2.0.0').problems.join()).toMatch(/outside the supported majors/)
  expect(probeSdk(sdk, '1.3.0').ok).toBe(true)
})

it('a pi that lost the launcher entry point is reported, not swallowed', () => {
  const problems = probeSdk({ SessionManager: {} }, '1.3.0')
  expect(problems.ok).toBe(false)
  expect(problems.problems.length).toBe(4)
})
