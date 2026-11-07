import { describe, expect, it } from 'vitest'
import { briefFor } from '../src/pi/router.ts'
import type { Mandate, Ticket } from '../src/core/index.ts'

const mandate = { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { id: 'matzen' }, scope: 'open the proxy on 8080 only' } as unknown as Mandate

describe('the worker brief', () => {
  it('says the mandate in words: a worker starts its life reading this text', () => {
    const brief = briefFor({ id: 'T1', title: 'open the proxy', channels: [{ thread: '#7' }], mandate } as unknown as Ticket, '/wt/T1')
    expect(brief).toContain('Mandate: open the proxy on 8080 only')
    expect(brief).not.toContain('[object Object]')
  })

  it('still briefs a ticket whose mandate is missing', () => {
    expect(briefFor({ id: 'T2', title: 'no mandate', channels: [] } as unknown as Ticket, '/wt/T2')).toContain('Mandate: (the ticket text)')
  })
})
