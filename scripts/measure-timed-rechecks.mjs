#!/usr/bin/env node
// node scripts/measure-timed-rechecks.mjs <owner/repo> <fromISO> [toISO] — the share agent-inbox#667 exists to cut.
// A report is a router-marked comment on an OPEN issue whose first line is `#<number> <state>`; that definition
// reproduces the 82-of-155 baseline as 78 of 151, which is the only reason the two numbers are comparable.
import { execFileSync } from 'node:child_process'

const [repo, from, to = new Date().toISOString()] = process.argv.slice(2)
if (!repo || !from) {
  console.error('usage: node scripts/measure-timed-rechecks.mjs <owner/repo> <fromISO> [toISO]')
  process.exit(2)
}
const MARK = '<!-- superagent -->'
const REPORT = /^#\d+ /
const TIMED = /Next check: a fresh worker looks at it at \d\d:\d\d UTC/
const gh = args => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }))
const paged = url => {
  const out = []
  for (let page = 1; ; page += 1) {
    const rows = gh(['api', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`])
    out.push(...rows)
    if (rows.length < 100) return out
  }
}

const issues = paged(`repos/${repo}/issues?state=open&since=${encodeURIComponent(from)}`).filter(r => !r.pull_request)
let reports = 0, timed = 0
const byState = {}
for (const issue of issues) {
  for (const c of paged(`repos/${repo}/issues/${issue.number}/comments?since=${encodeURIComponent(from)}`)) {
    if (!c.body?.includes(MARK) || !REPORT.test(c.body.trim())) continue
    if (c.created_at < from || c.created_at > to) continue
    reports += 1
    const state = c.body.trim().split(' ')[1]?.replace(/:$/, '').toLowerCase() ?? 'unknown'
    byState[state] = (byState[state] ?? 0) + 1
    if (TIMED.test(c.body)) timed += 1
  }
}
console.log(JSON.stringify({ repo, window: [from, to], issues: issues.length, reports, timed,
  share: reports ? +(100 * timed / reports).toFixed(1) : null, byState }))
