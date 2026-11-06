/** The pi surface the launcher touches: fakes share the launcher's reading of it, so only a real-install probe catches an update breaking it. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SUPPORTED_PI_MAJORS = [1]

export interface SdkProbeResult {
  ok: boolean
  version: string
  problems: string[]
}

export function installedPiVersion(sdkPath?: string): string {
  const roots = sdkPath
    ? [join(dirname(sdkPath), 'package.json'), join(dirname(dirname(sdkPath)), 'package.json')]
    : []
  for (const file of roots) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }
      if (parsed.name === '@earendil-works/pi-coding-agent' && parsed.version) return parsed.version
    } catch {
      // A root that is not pi's package.json is a miss, not an error: keep looking.
    }
  }
  return 'unknown'
}

export function probeSdk(sdk: unknown, version: string): SdkProbeResult {
  const problems: string[] = []
  const surface = sdk as {
    createAgentSession?: unknown
    SessionManager?: { inMemory?: unknown }
    DefaultResourceLoader?: unknown
    getAgentDir?: unknown
  } | null | undefined
  if (typeof surface?.createAgentSession !== 'function') {
    problems.push('createAgentSession is not a function — a worker cannot be started')
  }
  if (typeof surface?.SessionManager?.inMemory !== 'function') {
    problems.push('SessionManager.inMemory is not a function — a worker has no session store')
  }
  if (typeof surface?.DefaultResourceLoader !== 'function') {
    problems.push('DefaultResourceLoader is missing — the worker guard and the isolated judge cannot be built')
  }
  if (typeof surface?.getAgentDir !== 'function') problems.push('getAgentDir is missing — child sessions cannot find settings')
  const major = Number.parseInt(version, 10)
  if (Number.isFinite(major) && !SUPPORTED_PI_MAJORS.includes(major)) {
    problems.push(`pi ${version} is outside the supported majors [${SUPPORTED_PI_MAJORS.join(', ')}] — check the launcher against its SDK before trusting a worker`)
  }
  return { ok: problems.length === 0, version, problems }
}
