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
  it('a GitHub reply reaches a sink that can address it: asking only for a card dropped every one', async () => {
    const posts: string[] = []
    const outbox = new CommentOutbox(githubSink(posts), store())
    outbox.send(github('m1'))
    outbox.flush()
    await settle()
    expect(posts).toEqual(['m1'])
    expect(outbox.status('m1')).toBe('sent')
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
