import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { CommentOutbox, type CommentSink } from '../src/pi/outbox.ts'

const store = () => {
  const kv = new Map<string, unknown>()
  return { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k: string, v: unknown) => { kv.set(k, v) } }
}
const github = (id: string, issue = '138'): OutboundMessage =>
  ({ id, text: `ack ${id}`, channel: { source: 'github', thread: `#${issue}`, address: { issue } } }) as unknown as OutboundMessage
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const githubSink = (posts: string[], fail = { next: false }): CommentSink => ({
  accepts: () => true,
  post: async m => {
    if (fail.next) { fail.next = false; throw new Error('rate limited') }
    posts.push(m.id)
  },
})

describe('the outbox', () => {
  it('a reply reaches the sink that can address it', async () => {
    const posts: string[] = []
    const outbox = new CommentOutbox(githubSink(posts), store())
    outbox.send(github('m1'))
    outbox.flush()
    await settle()
    expect(posts).toEqual(['m1'])
    expect(outbox.status('m1')).toBe('sent')
  })

  it('a reply the channel will never take is given up on, not retried for the life of the router', async () => {
    // A pull request in a repository this account cannot see answers 404 forever: the router posted at it
    // 217 times, and the reply a person was owed sat in the queue with no end and no alarm.
    const posts: string[] = []
    const givenUp: Array<{ id: string; tries: number; error: string }> = []
    const deaf: CommentSink = { accepts: () => true, post: async () => { throw new Error('gh: Not Found (HTTP 404)') } }
    const outbox = new CommentOutbox(deaf, store(), () => Date.now(), 3, (m, tries, error) => givenUp.push({ id: m.id, tries, error }))
    outbox.send(github('m1'))
    for (let pass = 0; pass < 8; pass++) { outbox.flush(); await settle() }
    expect(posts).toEqual([])
    expect(outbox.status('m1'), 'no longer pending: it will not be retried').toBe('dropped')
    expect(givenUp).toEqual([{ id: 'm1', tries: 3, error: expect.stringContaining('Not Found (HTTP 404)') }])
  })

  it('a failed post stays pending and goes out on the next flush, once', async () => {
    const posts: string[] = []
    const fail = { next: true }
    const outbox = new CommentOutbox(githubSink(posts, fail), store())
    outbox.send(github('m1'))
    outbox.flush()
    await settle()
    expect(outbox.status('m1')).toBe('pending')
    outbox.flush()
    outbox.flush()
    await settle()
    expect(posts).toEqual(['m1'])
    expect(outbox.status('m1')).toBe('sent')
  })

  it('tells the sink when an attempt is a retry, even after a restart, so it can look before posting twice', async () => {
    const kv = store()
    const calls: boolean[] = []
    const dies: CommentSink = { accepts: () => true, post: (_m, _t, retry) => { calls.push(retry); return new Promise(() => {}) } }
    new CommentOutbox(dies, kv).send(github('m1'))
    new CommentOutbox(dies, kv).flush()
    // The process died mid-post; a fresh outbox over the same store is the restarted router.
    new CommentOutbox(dies, kv).flush()
    expect(calls).toEqual([false, true])
  })

  it('a message the sink cannot address is dropped, and never retried', () => {
    const posted: string[] = []
    const sink: CommentSink = { accepts: m => m.channel.source === 'github', post: m => { posted.push(m.id) } }
    const outbox = new CommentOutbox(sink, store())
    const homeless = { id: 'm2', text: 'ack', channel: { source: 'session', thread: 'inbox' } } as unknown as OutboundMessage
    outbox.send(github('m1'))
    outbox.send(homeless)
    expect(outbox.flush()).toBe(1)
    expect(outbox.status('m2')).toBe('dropped')
    expect(posted).toEqual(['m1'])
  })
})
