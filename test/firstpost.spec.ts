import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ACK_LEAD_WORDS, MAX_ACK_REFUSALS, POST_STRUCTURE, RUN_ON_WORDS, fallbackAcknowledgement, normalizePost, postBlocks, runOnProblems } from '../src/pi/firstpost.ts'
import { publishBody, REPLY_MARKER } from '../src/pi/source-github.ts'
import { receiptText } from '../src/pi/receipts.ts'
import { voiceProblems } from '../src/pi/voice.ts'
import { ghApi } from '../src/pi/gh-api.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'firstpost-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A post with every block kind a first post carries: heading, list, hard break, and a fenced block. */
const STRUCTURED = [
  'On it — the first post runs on because its writer never put a break in it.',
  '',
  '## What I will change',
  '',
  '- Keep every newline from the writer to GitHub.',
  '- Refuse a post that would land as one wall of text.',
  '',
  'The proof is the stored body  ',
  'it has its blank lines back.',
  '',
  '```ts',
  'const a = 1',
  '',
  'const b = 2',
  '```',
].join('\n')

/** The shape the operator reported: hundreds of words, one line, no break — the #1005 acknowledgement. */
const RUN_ON = `On it — and the word that diagnoses this is "first." ${
  'If only the initial post runs on and later comments format correctly, the writer of the first post is the layer at fault, not the renderer. '
    .repeat(9)}`

/** The blocks a reader sees, with the router's footer taken off. */
const publishedBlocks = (body: string): string[] => postBlocks(body.replace(`\n\n${REPLY_MARKER}`, ''))

describe('the first post on a thread (agent-inbox#1005)', () => {
  it('refuses the shape the operator reported and passes the shape the fix asks for', () => {
    expect(runOnProblems(RUN_ON), 'one long block with no markdown is the defect').toEqual([expect.stringContaining('run-on paragraph')])
    expect(voiceProblems(RUN_ON, null, { leadWords: ACK_LEAD_WORDS, allowCode: true }).length, 'the plain-language gate refuses it too').toBeGreaterThan(0)
    expect(runOnProblems(STRUCTURED), 'blocks, heading, list, fence: nothing to refuse').toEqual([])
    expect(voiceProblems(STRUCTURED, null, { leadWords: ACK_LEAD_WORDS, allowCode: true }),
      'and it passes the plain-language gate the report passes, fences included').toEqual([])
    expect(runOnProblems('on it'), 'a one-line acknowledgement is the ideal first post').toEqual([])
  })

  it('keeps every newline of a structured post, including the two spaces that are a hard break', () => {
    expect(normalizePost(STRUCTURED), 'normalizing a well-formed post changes nothing').toBe(STRUCTURED)
    const body = publishBody(STRUCTURED)
    expect(body.endsWith(`\n\n${REPLY_MARKER}`), 'the footer rides a blank line').toBe(true)
    expect(body).toContain('## What I will change\n\n- Keep every newline')
    expect(body).toContain('The proof is the stored body  \nit has its blank lines back.')
    expect(publishedBlocks(body), 'the fence and its blank line survive as written').toEqual(postBlocks(STRUCTURED))
  })

  it('normalizes line endings and runs of blanks without ever removing a break between blocks', () => {
    const crlf = 'Line one.\r\n\r\n## Heading\r\n\r\n- one\r\n- two\r\n\r\n\r\n\r\nTail  \r\n'
    expect(normalizePost(crlf), 'CRLF to LF, three blanks to one, the hard break kept').toBe('Line one.\n\n## Heading\n\n- one\n- two\n\nTail  ')
    expect(postBlocks(normalizePost(crlf))).toHaveLength(4)
    expect(normalizePost('a\n\n\n\n\nb')).toBe('a\n\nb')
    expect(normalizePost('one trailing space is not a break \nafter'), 'a lone trailing space carries no meaning').toBe('one trailing space is not a break\nafter')
    expect(normalizePost('```\ncode   \n\nmore\n```\ntail'), 'inside a fence every byte stands').toBe('```\ncode   \n\nmore\n```\ntail')
  })

  it('publishes a multi-paragraph body byte-for-byte through the same call that posts a reply', async () => {
    const dir = tmp()
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/bash\nprintf \'%s\\n\' "$(cat -)" >> "$(dirname "$0")/posts.log"\n')
    chmodSync(bin, 0o755)
    const api = ghApi({ repo: 'o/r', bin, followed: () => [] })
    await api.postComment(7, RUN_ON.slice(0, 900))
    await api.postComment(7, STRUCTURED)
    const lines = readFileSync(join(dir, 'posts.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { body: string })
    expect(publishedBlocks(lines[0]!.body), 'a run-on body reaches GitHub as it was written: one block').toHaveLength(1)
    expect(publishedBlocks(lines[1]!.body), 'a block-structured body reaches GitHub with its blocks').toEqual(postBlocks(STRUCTURED))
    expect(lines[1]!.body).toContain('- Keep every newline from the writer to GitHub.\n- Refuse a post')
    expect(lines[1]!.body).toContain('The proof is the stored body  \n')
    expect(lines[1]!.body).toContain('```ts\nconst a = 1\n\nconst b = 2\n```')
  })

  it('renders the first post and the follow-up comment path identically for the same payload', () => {
    const ack = publishedBlocks(publishBody(STRUCTURED))
    const receipt = publishedBlocks(publishBody(receiptText('#1005', 'worker', { state: 'ready', summary: STRUCTURED })))
    // A receipt glues `#1005 ready:` to the payload's line 1 and appends its own closing line; between them the
    // blocks are byte-identical, which is what "the follow-up renders the same way" has to mean.
    expect(ack, 'the first post keeps its five blocks').toHaveLength(5)
    expect(receipt.slice(1, 5), 'the receipt carries the same heading, list, hard break and fence').toEqual(ack.slice(1))
  })

  it('composes a first post from the accept fields when the judge will not write one that renders', () => {
    const ack = fallbackAcknowledgement('Fix the first post formatting')
    expect(ack).toBe('On it.\n\nI\'m working on: Fix the first post formatting.\n\n'
      + 'A worker runs this now. It reports on this issue, and a comment here reaches it.')
    expect(publishedBlocks(publishBody(ack)).length, 'blocks, not one line').toBe(3)
    expect(voiceProblems(ack, null, { leadWords: ACK_LEAD_WORDS }), 'the fallback passes the gate it enforces').toEqual([])
    const noisy = fallbackAcknowledgement('Fix `src/pi/x.ts` handling in /home/matzen/git/foo')
    expect(noisy.split('\n')[0], 'a title carrying a path never becomes line 1').toBe('On it.')
    expect(noisy, 'and the path never reaches the post at all').not.toContain('/home/matzen')
  })

  it('states the rule the judge, the brief and the refusal all quote, and refuses twice before writing it itself', () => {
    expect(POST_STRUCTURE).toContain('blank line between every paragraph')
    expect(POST_STRUCTURE).toContain('<br>')
    expect(RUN_ON_WORDS, 'the wall-of-text bar sits above a legal paragraph').toBeGreaterThan(80)
    expect(MAX_ACK_REFUSALS, 'a judge is asked to rewrite, then the router writes the post').toBe(2)
  })
})
