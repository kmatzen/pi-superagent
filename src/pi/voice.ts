// A brief's writing rule was only advice: a worker posted its 3,900-character to-do list as an update (2026-11-13). These are
// the error rules of the operator's own checker (~/.pi/agent/scripts/operator-text), plus that contract's Details limits.

/** The router puts `#123 ready:` in front of line 1, so the summary's own line 1 leaves two of the 25 words free. */
export const LEAD_WORDS = 23
const HEAD_WORDS = 160
const PARA_WORDS = 80
const BLOCK_LINES = 8
const TABLE_ROWS = 5
const DETAIL_BULLETS = 6
const DETAIL_WORDS = 160
const QUESTION_WORDS = 40

const INSIDER: Array<[RegExp, string]> = [
  [/(?<!\w)(~?\/[\w.-]+\/[\w./-]+|~?\/[\w.-]+)/, 'a file path'],
  [/\b[\w.-]+\/[\w.-]+[/.][\w./-]+\b/, 'a file path'],
  [/\b[0-9a-f]{7,40}\b/, 'a commit id'],
  [/\b\d+\s*\/\s*\d+\b/, 'a test score'],
  [/\b\d+\s*(?:passed|passing|passes|pass|failed|failing|fails?|checks?)\b/, 'a test count'],
  [/`[^`]+`/, 'a code span'],
]
const JARGON = ('worktree jsonl launchd tmux pane poller symlink md5 socket pid traceback stdin stdout regex daemon sha markdown '
  + 'footer lease heartbeat artifact cutover json rpc cdp e2e unit-test test-suite gate gates boilerplate idempotent fail-open fail-closed').split(' ')
const URL = /https?:\/\/\S+|www\.\S+/g
const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const BULLET = /^(\s*)[-*+]\s+/
/** The break before the skippable part; bold is accepted, since the receipt is rendered markdown. */
const DETAILS_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:<details>|details?|skippable|for the record|appendix|background|evidence|proof|context|technical detail)\b(?:\s*\([^)]*\))?\s*[:-]?\s*(?:\*\*|__)?\s*[:-]?\s*$/i

const words = (text: string): number => (text.match(/[^\s]+/g) ?? []).length
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

function stripCode(text: string): string {
  const out: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { fence = !fence; continue }
    if (!fence) out.push(line)
  }
  return out.join('\n')
}

function prose(text: string): string {
  const out: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { fence = !fence; continue }
    if (fence || TABLE_ROW.test(line) || line.trimStart().startsWith('#')) continue
    out.push(line)
  }
  return out.join('\n')
}

function leadProblems(lead: string): string[] {
  if (!lead) return ['there is no first sentence: start with the news or the ask']
  if (/^(?:#|-|\*|```|\||>)/.test(lead)) return ['line 1 is a heading, list or code, not a sentence: start with one plain sentence']
  const out: string[] = []
  const plain = lead.replace(URL, ' ')
  const n = words(plain)
  if (n > LEAD_WORDS) out.push(`line 1 is ${n} words (at most ${LEAD_WORDS}): keep it to the news, and move the rest down`)
  const insider = INSIDER.find(([pattern]) => pattern.test(plain))
  if (insider) out.push(`line 1 contains ${insider[1]} (${plain.match(insider[0])![0].slice(0, 40)}): the reader has no context for it, so move it to Details`)
  const jargon = JARGON.filter(w => new RegExp(`\\b${escape(w)}\\b`, 'i').test(plain))
  if (jargon.length) out.push(`line 1 uses insider words (${jargon.slice(0, 4).join(', ')}): say it in common words`)
  return out
}

export function voiceProblems(summary: string, question?: string | null): string[] {
  const lines = summary.split('\n')
  const leadAt = lines.findIndex(line => line.trim())
  const lead = leadAt < 0 ? '' : lines[leadAt]!.trim()
  const rest = leadAt < 0 ? lines : lines.slice(leadAt + 1)
  const cut = rest.findIndex(line => DETAILS_HEAD.test(line))
  const main = (cut < 0 ? rest : rest.slice(0, cut)).join('\n')
  const details = cut < 0 ? '' : rest.slice(cut + 1).join('\n')
  const head = leadAt < 0 ? main : `${lines[leadAt]}\n${main}`
  const out = leadProblems(lead)
  const headWords = words(prose(head))
  if (headWords > HEAD_WORDS) out.push(`${headWords} words come before the Details line (at most ${HEAD_WORDS}): keep three short result lines, move the rest under Details or into notes`)
  stripCode(head).split(/\n\s*\n/).forEach((para, i) => {
    if (words(para) > PARA_WORDS) out.push(`paragraph ${i + 1} is ${words(para)} words (at most ${PARA_WORDS}): split it, or move it to Details`)
  })
  let run = 0
  for (const line of head.split('\n')) {
    run = line.trim() && !FENCE.test(line) ? run + 1 : 0
    if (run === BLOCK_LINES + 1) { out.push(`more than ${BLOCK_LINES} lines run together with no blank line: one idea per line, blank lines between blocks`); break }
  }
  if (head.split('\n').some(line => FENCE.test(line))) out.push('a code or log block comes before the Details line: code goes last, or into notes')
  const body = `${summary}\n${question ?? ''}`.split('\n')
  const rows = body.filter(line => TABLE_ROW.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)).length
  if (rows > TABLE_ROWS) out.push(`a table has ${rows} rows (at most ${TABLE_ROWS}): summarise it in a few lines, and put the table in the pull request`)
  if (body.some(line => { const m = BULLET.exec(line); return m && Math.floor(m[1]!.replace(/\t/g, '        ').length / 2) + 1 >= 3 })) {
    out.push('a bullet is nested three levels deep (at most two): flatten it')
  }
  const bullets = details.split('\n').filter(line => BULLET.test(line)).length
  if (bullets > DETAIL_BULLETS || words(prose(details)) > DETAIL_WORDS) {
    out.push(`Details has ${bullets} bullets and ${words(prose(details))} words (at most ${DETAIL_BULLETS} and ${DETAIL_WORDS}): keep what the person may want; the rest goes into notes`)
  }
  if (question && words(question) > QUESTION_WORDS) out.push(`the question is ${words(question)} words (at most ${QUESTION_WORDS}): ask one short yes/no question`)
  return out
}

export const VOICE_REFUSED = (problems: readonly string[]): string => 'Not reported: the summary is posted on the issue for the person who asked, '
  + `and it fails the plain-language check:\n${problems.map(p => `- ${p}`).join('\n')}\n`
  + `What passes: line 1 is the news or the ask, in at most ${LEAD_WORDS} plain words; then at most three short lines of results; `
  + `then a line "Details (skippable):" and at most ${DETAIL_BULLETS} short bullets. File paths, code names, commit ids, logs and what `
  + 'to check next go in notes, which only the next worker on this ticket reads. Call ticket_report again.'
