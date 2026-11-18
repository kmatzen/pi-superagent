import { describe, expect, it } from 'vitest'
import { briefFor, pullBrief } from '../src/pi/router.ts'
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
    expect(briefFor({ id: 'T2', title: 'x', channels: [] } as unknown as Ticket, '/wt/T2'), 'reports in plain words')
      .toMatch(/Write the summary for the person who asked, in the words they use\. It is checked before it is posted and refused unless line 1/)
    expect(briefFor({ id: 'T2', title: 'x', channels: [] } as unknown as Ticket, '/wt/T2'), 'a handover report is the last act')
      .toMatch(/A ready or blocked report is your last act[\s\S]*finish every\s+change first, then report, then end your turn/)
    expect(briefFor({ id: 'T2', title: 'ci', channels: [] } as unknown as Ticket, '/wt/T2'), 'CI hands the slot over instead of watching it')
      .toMatch(/CI is never a reason to hold a session[\s\S]*report waiting with wakeInMinutes[\s\S]*a fresh worker is called back/)
    expect(briefFor({ id: 'T2', title: 'en', channels: [] } as unknown as Ticket, '/wt/T2'), 'English, whatever the model thinks in')
      .toMatch(/Write in English: every pull request title and body[\s\S]*whatever language you think in/)
    expect(briefFor({ id: 'T2', title: 'watch', channels: [] } as unknown as Ticket, '/wt/T2'), 'someone always watches')
      .toMatch(/Someone always watches what you start[\s\S]*report waiting\s+with wakeInMinutes/)
    expect(briefFor({ id: 'T2', title: 'close', channels: [] } as unknown as Ticket, '/wt/T2'), 'the router closes the issue')
      .toMatch(/Never write a closing keyword for this ticket's issue[\s\S]*Write "Part of"/)
  })
})

describe('how work reaches a repository', () => {
  it('asks for a pull request when the worker can push, and for a branch when it cannot', () => {
    // Measured 2026-11-10 with the isolated worker HOME: `gh api user` answers "please run gh auth login",
    // so the old brief sent every code ticket to a step it had no way to finish.
    expect(pullBrief('o/r#7')).toContain('gh pr create')
    expect(pullBrief('o/r#7')).toContain('Closes o/r#7')
    const isolated = pullBrief(undefined, false)
    expect(isolated).toContain('no GitHub access')
    expect(isolated).not.toContain('gh pr create')
  })

  it('asks for every pull request of a multi-repository change, in the order a person merges them', () => {
    expect(pullBrief('o/r#7')).toMatch(/comments on the code numbered: answer every number[\s\S]*list each number with what you did/)
    expect(pullBrief('o/r#7')).toMatch(/several pull requests,\s+in one repository or across several, list every one in pullRequests in the order a person should merge them/)
  })

  it('tells a worker the disk is shared and what never belongs on it', () => {
    const brief = briefFor({ id: 'T3', title: 'x', channels: [] } as unknown as Ticket, '/wt/T3')
    expect(brief).toMatch(/never download model weights, datasets or checkpoints\s+onto it/)
    expect(brief).toMatch(/Before a ready report delete what you made that is not code/)
    expect(brief).toMatch(/Write scratch to \$TMPDIR, which is inside your workspace, never to \/tmp/)
  })

  it('says where results go, that the pod must be able to write them, and that the links go on the issue', () => {
    // Operator, 2026-11-17: a pod's disk dies with the pod, and an experiment nobody can see is not a result.
    const ticket = { id: 'abcd1234ef567890', title: 'dose curve', channels: [{ thread: '#507' }] } as unknown as Ticket
    const brief = briefFor(ticket, '/wt/abcd1234')
    expect(brief).toMatch(/s3:\/\/matzen-adobe\/superagent\/507-abcd1234\/[\s\S]*the pod's disk dies with the pod/)
    expect(brief, 'prove the role can write before the run, not after').toMatch(/Pluto pod whose resource role can write that bucket[\s\S]*one small upload before the run[\s\S]*report blocked naming the pod and the role it lacks/)
    expect(brief, 'a finished experiment without a picture reports blocked, not ready').toMatch(/A ready report for a run that held a GPU job claim is refused without results links[\s\S]*A waiting report needs none/)
  })
})
