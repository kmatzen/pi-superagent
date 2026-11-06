import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The engine reads PI_SUPERAGENT_* from the shell; inheriting them makes the suite test a live engine.
const keys = Object.keys(process.env).filter(k => k.startsWith('PI_SUPERAGENT_'))
for (const k of keys) delete process.env[k]

// A router built from the environment reaches herdr by name, and on the real one its stale-tab sweep closed the
// live router's worker tabs: on the suite's PATH, `herdr` is a stub that refuses every call.
const stub = mkdtempSync(join(tmpdir(), 'no-herdr-'))
writeFileSync(join(stub, 'herdr'), '#!/bin/sh\necho \'{"error":{"code":"test_suite","message":"tests never call the real herdr"}}\' >&2\nexit 1\n')
chmodSync(join(stub, 'herdr'), 0o755)
process.env.PATH = `${stub}:${process.env.PATH ?? ''}`
