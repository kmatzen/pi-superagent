/** Bot lists are patterns (`pi-*`, `fleet-*`): an exact lookup let every fleet agent's comment count as a person's. */
export function isListed(author: string, patterns: ReadonlySet<string> | undefined): boolean {
  if (!patterns) return false
  for (const pattern of patterns) {
    if (!pattern.includes('*')) { if (pattern === author) return true; continue }
    const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    if (new RegExp(`^${source}$`).test(author)) return true
  }
  return false
}
