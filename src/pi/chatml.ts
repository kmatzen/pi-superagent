/**
 * ChatML control-token armor (agent-inbox#1085). A raw <|...|> control token entering a worker context
 * (issue text, files, tool output, inherited prose) is what derails a chat model mid-generation; this
 * escapes them to a token-shaped string on ingress and restores them on egress, where no tokenizer reads.
 * Escape is idempotent (the negative lookahead skips an already-escaped opening) and exactly inverted by
 * unescape, so worker text round-trips unchanged.
 */
const RAW_TOKEN = /<\|(?!~)([A-Za-z0-9_#-]{1,64})\|>/g
const ESCAPED_TOKEN = /<\|~([A-Za-z0-9_#-]{1,64})\|>/g

/** Escape raw tokens. Idempotent: an escaped opening carries the `~` the lookahead skips. */
export const escapeControlTokens = (text: string): string => text.replace(RAW_TOKEN, '<|~$1|>')

/** The exact inverse, so a worker quoting escaped text is restored verbatim on egress. */
export const unescapeControlTokens = (text: string): string => text.replace(ESCAPED_TOKEN, '<|$1|>')

/**
 * Escape the text of a pi `tool_result` event's content (blocks or a bare string); returns undefined
 * when nothing changed, so the hook can leave the result untouched.
 */
export function escapeToolResultContent(content: unknown): { content: unknown } | undefined {
  if (typeof content === 'string') {
    const escaped = escapeControlTokens(content)
    return escaped === content ? undefined : { content: escaped }
  }
  if (!Array.isArray(content)) return undefined
  let touched = false
  const out = content.map(block => {
    if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      const escaped = escapeControlTokens(String((block as { text: unknown }).text))
      if (escaped !== (block as { text: string }).text) {
        touched = true
        return { ...(block as Record<string, unknown>), text: escaped }
      }
    }
    return block
  })
  return touched ? { content: out } : undefined
}
