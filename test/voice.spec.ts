import { describe, expect, it } from 'vitest'
import { voiceProblems } from '../src/pi/voice.ts'

// The update a worker posted on agent-inbox#394 (2026-11-13), first part: its own to-do list, file paths first.
const NOTEBOOK = `CI GitHub 403 is fixed in code; PR #2039 is open and its CI run is mid-flight — I need a check-back in ~50 min to confirm the pod clone succeeded.

**Root cause (measured, not inferred).** The token the CI credential is *not* what pods use. \`caramel/pluto/launcher.py\` discarded the Jenkins credential (\`cloud-github-app-research-adobe\`, passed as \`--github-token\`) whenever the launching principal had an AIP user secret named \`GITHUB_TOKEN\` — 51 times in Jenkins PR-2026 build #36's console — so each pod cloned private mirrors as the *launch principal's* secret. Pod logs mirrored to \`s3://phidias/caramel/ci/pluto-logs/\` on 2026-11-13 split cleanly: pods created by \`sp-59f663b0\` (service principal) printed \`GITHUB_TOKEN sourced from AIP-injected env var\` then 3x SAML \`authorization_request\` 403 on \`ml-depth-pro\` and exited; pods created by \`matzen\` printed the same source line and cloned geocalib/Pi3/spatial-utils3d/vggt. So the SP's stored GitHub token has never been SAML-authorized for the org, and CI passed or failed by launch principal.

**The fix (PR #2039, 12 files, +422/-9).** An explicit \`--github-token\` (what CI passes) now wins over the AIP user secret; a bare \`GITHUB_TOKEN\` env var still loses to it, so the documented no-plaintext path for interactive launches is unchanged.`

const PLAIN = `The CI failures came from the wrong GitHub token reaching the test machines; my fix is in review, and one setting needs you.

- Runs started by the service account used its token, which was never approved for the company's GitHub; runs started by you passed.
- The fix makes test runs use the CI token, and fails in seconds, naming the fix, when a token is refused.

Ask: approve the service account's GitHub token for the company login?

Details (skippable):
- Pull request: https://github.com/Research-Adobe/caramel/pull/2039
- The new tests run in the CI test stage.`

const bullets = (n: number, wordsEach: number): string =>
  Array.from({ length: n }, (_, i) => `- point ${i} ${'word '.repeat(wordsEach - 2).trim()}`).join('\n')

describe('the plain-language check on a report', () => {
  it('refuses the to-do list a worker posted as an update, and says what to fix', () => {
    const problems = voiceProblems(NOTEBOOK)
    expect(problems.join('\n')).toMatch(/line 1 is 31 words \(at most 23\)/)
    expect(problems.join('\n')).toMatch(/words come before the Details line/)
    expect(problems.join('\n')).toMatch(/paragraph 2 is \d+ words/)
  })

  it('passes the same news written for the person who asked', () => {
    expect(voiceProblems(PLAIN)).toEqual([])
  })

  // voice_rules.py LEAD_FIXTURES: the operator's checker and this one agree on every lead.
  it.each([
    ['Merge PR https://github.com/matzen_adobe/fleet-board/pull/1 — it is green and nothing is queued behind it.', false],
    ['Need your go to merge the fleet-board fix.', false],
    ['Gate the board hook so every session passes the checks.', true],
    ['No decision needed.', false],
    ['Fixed the readability of agent text and shipped it as a draft pull request, the checker is green on every rule and the installer '
      + 'puts the rule into every session on this box, so tell me to merge it when you have a minute.', true],
    ['Deployed at 21:45Z under the TASK-136 approval: fleet_witness.py 1633e9b0 and audit-stuck 0de93e8a, repo == deployed.', true],
    ['78 passed 0 failed', true],
    ['acted: the tag is now mechanical, not courteous. Branch `wt/decision-label-release`, commit 37f68e5, worktree `/Users/matzen/git/...`', true],
    ['Rebased the worktree onto master and restarted the poller daemon.', true],
    ['- shipped the gate', true],
    ['', true],
  ])('lead %j refused: %s', (lead, refused) => {
    expect(voiceProblems(lead).length > 0).toBe(refused)
  })

  it('keeps Details short too, and takes a bold Details line as the break', () => {
    const lead = 'The upload fix is in review.'
    expect(voiceProblems(`${lead}\n\nDetails (skippable):\n${bullets(7, 5)}`).join('\n')).toMatch(/Details has 7 bullets/)
    expect(voiceProblems(`${lead}\n\n**Details (skippable):**\n${bullets(6, 25)}`)).toEqual([])
    expect(voiceProblems(`${lead}\n\n**Details:**\n${bullets(6, 25)}`)).toEqual([])
  })

  it('refuses a question that is not one short question', () => {
    expect(voiceProblems('The upload fails on large files.', `Should ${'large '.repeat(45)}files go up in parts?`).join('\n'))
      .toMatch(/the question is \d+ words \(at most 40\)/)
    expect(voiceProblems('The upload fails on large files.', 'Should large files go up in parts?')).toEqual([])
  })
})
