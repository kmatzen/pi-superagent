/** The first post on a thread had no writing rule and no gate, so GitHub rendered it as one run-on paragraph (agent-inbox#1005). */
import { PARA_WORDS } from './voice.ts'

export const POST_STRUCTURE = 'GitHub renders a single newline as a soft break, so text written as one line shows its reader '
  + 'one run-on paragraph. Write GitHub markdown in blocks: a blank line between every paragraph, heading, list, '
  + 'table and code fence, and two trailing spaces where a line is meant to break inside a paragraph. Write real '
  + 'newlines — never `\\n` escapes, never `<br>`.'

/** Deliberately above `PARA_WORDS`: a long paragraph of prose is legal, a wall of text with no markdown is not. */
export const RUN_ON_WORDS = 160

export const MAX_ACK_REFUSALS = 2

/** A receipt's line 1 carries the router's `#123 ready:` prefix, so the gate gives it 23 words; an
 *  acknowledgement is posted bare and gets the whole 25. */
export const ACK_LEAD_WORDS = 25

/** The first post's contract, quoted by the tool schema, the judge's prompt, the brief and the refusal alike. */
export const ACK_FORMAT = 'The first thing the person who asked reads on their issue, in GitHub markdown blocks: '
  + `line 1 is what you took up, in at most ${ACK_LEAD_WORDS} plain words (no file path, code name or commit id), `
  + 'then at most three short lines, with a blank line between every block. ' + POST_STRUCTURE

const FENCE = /^\s*(```|~~~)/
const BLOCK_MARKER = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||!\[|\[\^[^\]]+\])/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const words = (text: string): number => (text.match(/[^\s]+/g) ?? []).length

export function postBlocks(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fence: string | null = null
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const open = FENCE.exec(line)
    if (fence) {
      current.push(line)
      if (open && open[1] === fence) { out.push(current.join('\n')); current = []; fence = null }
      continue
    }
    if (open) { fence = open[1]!; current.push(line); continue }
    if (line.trim()) { current.push(line); continue }
    if (current.length) { out.push(current.join('\n')); current = [] }
  }
  if (current.length) out.push(current.join('\n'))
  return out
}

export function runOnProblems(text: string): string[] {
  const wall = postBlocks(text ?? '').find(b => !TABLE_ROW.test(b)
    && !b.split('\n').some(line => BLOCK_MARKER.test(line)) && words(b) > RUN_ON_WORDS)
  if (!wall) return []
  return [`one block of ${words(wall)} words has no blank line and no markdown in it, so GitHub renders it as one `
    + 'run-on paragraph: break it into paragraphs and lists with blank lines between them']
}

/** Keeps every break, and keeps the two trailing spaces that *are* a hard break: a linter that strips them turns
 *  a hard break back into a soft one, which is the defect this file exists to fix. */
export function normalizePost(text: string): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let fence = false
  let blanks = 0
  for (const line of lines) {
    if (FENCE.test(line)) { fence = !fence; out.push(line.replace(/[ \t]+$/, '')); blanks = 0; continue }
    if (fence) { out.push(line); continue }
    if (!line.trim()) { blanks += 1; if (blanks <= 1) out.push(''); continue }
    blanks = 0
    out.push(/ {2,}$/.test(line) ? `${line.replace(/ +$/, '')}  ` : line.replace(/[ \t]+$/, ''))
  }
  while (out.length && !out.at(-1)!.trim()) out.pop()
  return out.join('\n')
}

const plainTitle = (title: string): string => String(title ?? '')
  .replace(/`/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)

/** A title with any slash in it is a path or a repo name, and line 1 of a first post carries neither. */
const PATHLIKE = /\S*\/\S/

/** Composed from the accept's own fields, for a judge that will not write a first post that renders. */
export function fallbackAcknowledgement(title: string): string {
  const named = plainTitle(title)
  const said = named && !PATHLIKE.test(named) ? `\n\nI'm working on: ${named}.` : ''
  return `On it.${said}\n\nA worker runs this now. It reports on this issue, and a comment here reaches it.`
}

export const ACK_REFUSED = (problems: readonly string[]): string =>
  'Not decided: the acknowledgement is the first thing the person who asked reads on their issue, and it would '
  + 'not render as written:\n' + problems.map(p => `- ${p}`).join('\n') + '\n'
  + POST_STRUCTURE + '\n'
  + 'Keep it short: line 1 is what you took up, in one plain sentence; then at most three short lines; a blank '
  + 'line between every block. Call ticket_decide again with the same evalId, kind, title, scope and reason, and '
  + 'the acknowledgement fixed. Nothing is decided yet.'

/** What a worker is told when a command would publish a wall of text, in the same voice as `NOT_ENGLISH`. */
export const PUBLISH_REFUSED = (problems: readonly string[]): string =>
  'Not sent: what this command publishes would not render as written:\n' + problems.map(p => `- ${p}`).join('\n') + '\n'
  + POST_STRUCTURE + '\n'
  + 'Rewrite the body in blocks and send it again.'
