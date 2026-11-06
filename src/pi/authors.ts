/** Bot lists are patterns (`pi-*`, `fleet-*`): an exact lookup let every agent the pattern names pass for a person. */
export function isListed(author: string, patterns: ReadonlySet<string> | undefined): boolean {
  if (!patterns) return false
  for (const pattern of patterns) {
    if (!pattern.includes('*')) { if (pattern === author) return true; continue }
    const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    if (new RegExp(`^${source}$`).test(author)) return true
  }
  return false
}

/** A login no person writes from: a GitHub App installation is always `<app>[bot]`, a machine account is
 *  one the operator's bot list names. Only these may be adopted as the agent's identity unasked. */
export function isBotLogin(login: string, patterns: ReadonlySet<string> | undefined): boolean {
  return login.endsWith('[bot]') || isListed(login, patterns)
}
