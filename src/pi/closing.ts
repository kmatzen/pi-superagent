/** Workers never write a closing keyword for a board issue: GitHub closes the issue the moment that one pull request
 *  merges, while the ticket's other pull requests are still open (2026-11-13: merging the first of five closed #340). */

const KEYWORD = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*`

/** The first reference in `text` that would close an issue of `home` (`owner/name`) on merge, or undefined. */
export function closesBoardIssue(text: string, home: string): string | undefined {
  if (!home) return undefined
  const repo = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${KEYWORD}(?:${repo}#|https?://github\\.com/${repo}/issues/)\\d+`, 'i').exec(text)?.[0]
}

export const closingRefused = (phrase: string): string => `Not sent: "${phrase}" closes the ticket's issue as soon as this `
  + 'merges, while its other pull requests may still be open. Write "Part of" with the same reference instead; the router '
  + 'closes the issue when every pull request is done.'
