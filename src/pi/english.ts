/** Workers write in English. The fleet's default model drifted into Chinese and opened four pull requests with Chinese
 *  bodies (2026-11-12), so every text a worker publishes is checked before it leaves. */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff66-\uff9f]/gu
/** A short quote (an error message, a file name) passes; a sentence does not. */
export const NON_ENGLISH_LIMIT = 10

export const NOT_ENGLISH = 'Not sent: this text is not in English. Write every pull request, issue, comment, commit message and '
  + 'ticket_report in English, whatever language you think in, then send it again.'

export const nonEnglish = (text: string): boolean => (text.match(CJK) ?? []).length >= NON_ENGLISH_LIMIT

const PUBLISHES = /\bgh\s+(?:pr|issue)\s+(?:create|edit|comment|review)\b|\bgh\s+api\b|\bgit\b[^|;&\n]*\b(?:commit|tag)\b/
/** `--body-file`, `-F`/`--file` (gh, git commit) and `gh api` fields read with `@`: text that lives in a file. */
const FROM_FILE = /(?:--body-file|--file|-F)(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|]+)|=@("[^"]+"|'[^']+'|[^\s;&|]+)/g
const unquote = (s: string): string => s.replace(/^["']|["']$/g, '')

/** The text a shell command would publish to GitHub or into git history, files included; undefined when it publishes none. */
export function publishedText(command: string, workspace: string): string | undefined {
  if (!PUBLISHES.test(command)) return undefined
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/.exec(command)?.[1]
  const base = cd ? (isAbsolute(unquote(cd)) ? unquote(cd) : join(workspace, unquote(cd))) : workspace
  const files = [...command.matchAll(FROM_FILE)].map(m => unquote(m[1] ?? m[2] ?? '')).filter(f => f && f !== '-')
  const bodies = files.map(f => {
    try { return readFileSync(isAbsolute(f) ? f : join(base, f), 'utf8').slice(0, 200_000) } catch { return '' }
  })
  return [command, ...bodies].join('\n')
}
