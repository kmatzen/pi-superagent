/** Panel and management API over the engine's own store: the panel can show no count the API denies. */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Engine, Ticket } from '../core/index.ts'
import type { SqliteRepositories } from './store.ts'
import type { SessionAssessor } from './assessor.ts'
import type { RouterConfig } from './router.ts'
import { parsePull, parseThread, threadOfPull, threadUrl } from './pulls.ts'
import { WON_SLOT_KEY } from './source-github.ts'

export interface PanelSource {
  repos: SqliteRepositories
  engine: Engine
  assessor: SessionAssessor
  config: RouterConfig
  load(): { running: number; parked: number; queued: number; maxWorkers: number; starved?: number; oldestStarvedH?: number; unanswered?: number }
  /** The router's live workers: which ticket, where, and when each last spoke. */
  workers(): Array<{ ticketId: string; sessionId: string; workspace: string; lastEventAt: string; events: number; quietSeconds: number; watch?: string; busy?: boolean }>
  /** The panel shares the router's event loop, so a slow request is evidence of starvation, not noise. */
  log(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void
  /** The same document `superagent status` reads, so the panel and the exit code cannot disagree. */
  health(): Record<string, unknown>
  isPaused(): boolean
  setPaused(v: boolean): void
  /** Required on every POST: a localhost bind stops remote callers, not local ones. */
  token?(): string
  /** A worker's terminal. Absent when workers do not run in herdr tabs. */
  workerPane?(ticketId: string, lines: number): Promise<{ tab: string; agent: string; text: string }>
  workerPrompt?(ticketId: string, text: string): Promise<void>
  workerKeys?(ticketId: string, keys: string[]): Promise<void>
  now(): string
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const day = 86_400_000
const within = (at: string, ms: number, now: string): boolean => Date.parse(at) >= Date.parse(now) - ms

/** A ticket's home is its GitHub issue page. */
export const issueUrl = (t: Ticket, repo?: string): string => {
  const c = t.channels[0]
  return (c?.source === 'github' && threadUrl(c.thread, repo ?? '')) || ''
}

const waitingOn = (t: Ticket): string => {
  const a = t.assignments.at(-1)
  if (t.attention) return `a person: ${(t.attention as { question?: string }).question ?? ''}`.trim()
  const review = (t.follows ?? []).filter(f => f.own && !f.closed).map(f => f.thread.replace(/^github:/, ''))
  if (a?.report?.state === 'ready' && review.length) return `review of ${review.join(', ')}`
  if (a?.report?.state === 'waiting') return 'a trigger'
  if (a?.state === 'running') return 'its worker'
  if (a?.state === 'pending' || !a) return 'the router'
  return 'the operator'
}

export function readModel(src: PanelSource) {
  const now = src.now()
  const tickets = src.repos.tickets.list()
  // Newest first: list() is insertion order, and the operator opens this panel for the ticket that just
  // landed. The ended list below says the same thing about its own order.
  const open = tickets.filter(t => !t.ended).reverse()
  const threads = src.repos.threads.list()
  const decisions = threads.flatMap(t => src.repos.decisions.byThread(t.key))
  const filtered = threads.flatMap(t => src.repos.triggersOfThread(t.ref))
    .map(tr => ({ trigger: tr, disposition: src.repos.triggers.disposition(tr.id) }))
  const recent = filtered.filter(f => within(f.trigger.at, day, now))
  return {
    now,
    paused: src.isPaused(),
    health: src.health(),
    load: src.load(),
    needsPerson: open.filter(t => t.attention).map(t => {
      const r = t.assignments.at(-1)?.report
      const summary = String(r?.summary ?? '')
      return {
        id: t.id, title: t.title, thread: t.channels[0]?.thread ?? '',
        question: (t.attention as { question?: string }).question ?? '',
        summary,
        // The router nudges when a worker goes silent; that is the router speaking, not the worker asking.
        nudged: /^the worker (sent no event|has run)/.test(summary),
        screen: `/worker?ticket=${encodeURIComponent(t.id)}`,
        at: r?.at ?? '', url: issueUrl(t, src.config.githubRepo),
      }
    }),
    open: open.map(t => ({ id: t.id, title: t.title, thread: t.channels[0]?.thread ?? '', state: t.assignments.at(-1)?.state ?? 'queued',
      wonSlot: (src.repos.kv.get<Record<string, string>>(WON_SLOT_KEY) ?? {})[t.channels[0]?.thread ?? ''] ?? '', waitsFor: waitingOn(t),
      screen: `/worker?ticket=${encodeURIComponent(t.id)}`,
      issue: t.channels[0]?.source === 'github' ? t.channels[0].thread : '', url: issueUrl(t, src.config.githubRepo),
      worker: (() => { const w = src.workers().find(w => w.ticketId === t.id); return w ? `${w.busy === false ? 'parked · ' : ''}watch ${w.watch || w.workspace} · ${w.events} events · quiet ${w.quietSeconds}s` : '' })() })),
    workers: src.workers(),
    // Newest first: list() is insertion order, so the panel reverses rather than the store lying about it.
    ended: tickets.filter(t => t.ended).reverse().slice(0, 50).map(t => ({ id: t.id, title: t.title, outcome: t.ended!.outcome, at: t.ended!.at })),
    counts: {
      triggers24h: recent.length,
      filtered24h: recent.filter(f => f.disposition?.filtered).length,
      decisions24h: decisions.filter(d => within(d.at, day, now)).length,
      evaluating: threads.filter(t => t.evaluating).length,
      threads: threads.length,
    },
    evaluating: threads.filter(t => t.evaluating).map(t => ({ key: t.key, evalId: t.evaluating!.id, since: t.evaluating!.startedAt })),
    waitingAssessment: src.assessor.waiting(),
    recentDecisions: decisions.slice(-25).reverse().map(d => ({ id: d.id, at: d.at, kind: d.kind, reason: d.reason.map(r => r.code).join(','), rules: (d.audit?.rules as string[] | undefined) ?? [], ticket: d.ticketId ?? '' })),
    policy: { version: src.config.policyVersion ?? 'v1', paused: src.isPaused() },
    source: { repo: src.config.githubRepo ?? '' },
  }
}

export type Model = ReturnType<typeof readModel>

const page = (title: string, body: string): string => `<!doctype html><meta charset=utf-8>
<title>${esc(title)}</title><style>
body{font:14px/1.45 system-ui;margin:2rem auto;max-width:60rem;color:#111;background:#fbfbfa}
nav a{margin-right:1rem}h1{font-size:1.3rem}h2{font-size:1.05rem;margin-top:2rem;border-bottom:1px solid #ddd}
table{border-collapse:collapse;width:100%}td,th{padding:.3rem .5rem;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.count{color:#666}.ask{background:#fff8dc;padding:.5rem;border-left:3px solid #c90}
.muted{color:#666}code{background:#eee;padding:0 .2rem}
</style>
<nav><a href="#overview">Overview</a><a href="#source">Source</a><a href="#trigger">Trigger</a><a href="#eval">Eval</a><a href="#workers">Workers</a><a href="#execution">Execution</a><a href="#settings">Settings</a></nav>
<h1>${esc(title)}</h1>${body}`

export function renderPanel(m: Model): string {
  const quiet = (n: number, label: string): string => n === 0 ? '' : `<li>${n} ${esc(label)}</li>`
  const asks = m.needsPerson.map(a => `<div class="ask">${a.url ? `<a href="${esc(a.url)}">${esc(a.thread)}</a>` : `<a href="/ticket?id=${encodeURIComponent(a.id)}">${esc(a.thread || a.id)}</a>`} — ${a.nudged ? `<strong>quiet, no question from the worker</strong>: ${esc(a.summary)}` : esc(a.question || a.summary || 'needs a person')}<div class="muted">${esc(a.title)} · <a href="${esc(a.screen)}">screen</a> · <button class="stop" data-ticket="${esc(a.id)}">stop</button></div></div>`).join('')
    || '<p class="muted">Nothing needs you.</p>'
  const rows = (rows: Record<string, unknown>[], cols: string[]): string => {
    if (rows.length === 0) return '<p class="muted">none</p>'
    const cell = (r: Record<string, unknown>, c: string): string =>
      c === 'screen' && r[c] ? `<a href="${esc(r[c])}">screen</a>`
        : c === 'stop' && r.id ? `<button class="stop" data-ticket="${esc(r.id)}">stop</button>`
          : r.url ? `<a href="${esc(r.url)}">${esc(r[c])}</a>` : esc(r[c])
    return `<table><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${cell(r, c)}</td>`).join('')}</tr>`).join('')}</table>`
  }
  return page('superagent', `
<section id="overview"><h2>Needs a person <span class="count">(${m.needsPerson.length})</span></h2>${asks}
<ul class="count">${quiet(m.load.running, 'workers on a run')}${quiet(m.load.parked, 'workers parked between runs')}${quiet(m.load.starved ?? 0, `labelled asks waiting for a slot${m.load.oldestStarvedH ? `, oldest ${m.load.oldestStarvedH}h` : ''}`)}${quiet(m.load.unanswered ?? 0, 'labelled asks with nobody on them')}${quiet(m.counts.evaluating, 'evals in progress')}${quiet(m.counts.filtered24h, 'triggers filtered in 24 h')}${m.paused ? '<li><strong>processing is paused</strong></li>' : ''}</ul></section>
<section id="source"><h2>Source <span class="count">(${m.source.repo ? `GitHub issues: ${esc(m.source.repo)}` : 'no source configured'})</span></h2>
<p class="count">${m.counts.triggers24h} triggers in the last 24 h, ${m.counts.filtered24h} filtered, ${m.counts.threads} threads known.</p>
</section>
<section id="trigger"><h2>Trigger</h2>${rows(m.evaluating, ['key', 'evalId', 'since'])}
<p class="count">Waiting on a judgement: ${m.waitingAssessment.length}</p></section>
<section id="eval"><h2>Eval <span class="count">(${m.counts.decisions24h} in 24 h)</span></h2>${rows(m.recentDecisions, ['at', 'kind', 'reason', 'rules', 'ticket'])}</section>
<section id="workers"><h2>Workers <span class="count">(${m.workers.length} with a tab: ${m.load.running} on a run, ${m.load.parked} parked)</span></h2>
${rows(m.workers.map(w => ({ thread: w.ticketId.slice(0, 8), title: w.workspace.split('/').pop() ?? w.workspace, state: w.busy === false ? 'parked' : 'running', screen: `/worker?ticket=${encodeURIComponent(w.ticketId)}`, detail: `${w.watch || w.workspace} · ${w.events} events · quiet ${w.quietSeconds}s` })), ['thread', 'title', 'state', 'detail', 'screen'])}</section>
<section id="execution"><h2>Execution <span class="count">(${m.open.length} open, ${m.load.running}/${m.load.maxWorkers} working, ${m.load.parked} parked, ${m.load.queued} queued)</span></h2>
${rows(m.open, ['thread', 'title', 'state', 'wonSlot', 'waitsFor', 'worker', 'screen', 'stop'])}
<h2>Ended</h2>${rows(m.ended, ['id', 'title', 'outcome', 'at'])}</section>
<section id="settings"><h2>Settings</h2><p class="count">policy ${esc(m.policy.version)} · paused=${m.paused} · state ${esc(process.env.PI_SUPERAGENT_STATE ?? '')}</p>
<p class="muted">Settings live in config.env in the state directory; restart to apply them. POST /api/executor/pause pauses processing.</p></section>
<script>
document.addEventListener('click', async function (e) {
  var b = e.target.closest && e.target.closest('button.stop'); if (!b) return
  if (!window.confirm('Stop this ticket? Its worker is released and the ticket ends.')) return
  var r = await fetch('/api/tickets/' + encodeURIComponent(b.dataset.ticket) + '/stop', {
    method: 'POST', credentials: 'include',
    headers: { 'x-superagent-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'stopped from the panel' }),
  })
  b.textContent = r.ok ? 'stopped' : 'refused ' + r.status
})
</script>`)
}

const json = (res: import('node:http').ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise(resolve => { let b = ''; req.on('data', (c: Buffer) => { b += c }); req.on('end', () => resolve(b)) })

/** Polled every few seconds, not streamed: watching a run needs the last screen, not a socket. */
const workerPage = (ticket: string, canType: boolean): string => page(`worker ${ticket}`, `
<p><a href="/">&larr; panel</a> <span class="count" id="where"></span></p>
<pre id="screen" style="white-space:pre-wrap;background:#111;color:#eee;padding:.6rem;overflow:auto;max-height:70vh">loading…</pre>
${canType ? `<p><textarea id="msg" rows="3" style="width:100%" placeholder="say something to this worker; the Send button submits it as a prompt"></textarea>
<button type="button" id="send">Send</button> <button type="button" id="esc">Esc</button> <span class="count" id="sent"></span></p>` : '<p class="muted">These workers do not run in herdr tabs, so there is nothing to type into.</p>'}
<script>
var ticket = ${JSON.stringify(ticket)}
function tok() { var t = localStorage.getItem('superagent-panel-token') || ''; if (!t) { t = window.prompt('panel token (the panel-token file in the state directory)') || ''; localStorage.setItem('superagent-panel-token', t) } return t }
function note(s) { document.getElementById('sent').textContent = s }
async function refresh() {
  try {
    var r = await fetch('/api/worker?ticket=' + encodeURIComponent(ticket) + '&lines=80', { headers: { 'x-superagent-request': '1' } })
    var j = await r.json()
    document.getElementById('screen').textContent = (j.text !== undefined ? j.text : JSON.stringify(j, null, 2)) + '\n'
    document.getElementById('where').textContent = j.tab ? ' · ' + j.tab + ' · agent ' + j.agent : ''
  } catch (e) { document.getElementById('screen').textContent = String(e) + '\n' }
}
document.getElementById('send')?.addEventListener('click', async function () {
  var text = document.getElementById('msg').value
  if (!text.trim()) return note('nothing to send')
  note('sending…')
  var r = await fetch('/api/worker/prompt', { method: 'POST', headers: { 'x-superagent-request': '1', 'x-superagent-token': tok() }, body: JSON.stringify({ ticket: ticket, text: text }) })
  var j = await r.json(); note(r.ok ? 'sent' : 'refused: ' + j.error); if (r.ok) document.getElementById('msg').value = ''
})
document.getElementById('esc')?.addEventListener('click', async function () {
  var r = await fetch('/api/worker/keys', { method: 'POST', headers: { 'x-superagent-request': '1', 'x-superagent-token': tok() }, body: JSON.stringify({ ticket: ticket, keys: ['esc'] }) })
  note(r.ok ? 'esc sent' : 'refused: ' + (await r.json()).error)
})
refresh(); setInterval(refresh, 3000)
</script>`)

/** The token from the header a script sends, or the Basic password a browser prompts for. */
const bearerToken = (headers: IncomingMessage['headers']): string => {
  const header = String(headers['x-superagent-token'] ?? '')
  if (header) return header
  const basic = String(headers.authorization ?? '')
  if (!/^basic /i.test(basic)) return ''
  try { return Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') } catch { return '' }
}

const allowedHost = (src: PanelSource, host: string): boolean => {
  const base = host.replace(/:\d+$/, '')
  return base === 'localhost' || base === '127.0.0.1' || (src.config.panelHosts ?? []).includes(base)
}

export function createPanelServer(src: PanelSource): { server: Server; url(port: number): string } {
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    const began = Date.now()
    res.on('finish', () => {
      const ms = Date.now() - began
      if (ms > 1000) src.log('warn', 'panel.slow', { ms, path: req.url ?? '/', status: res.statusCode })
    })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const host = String(req.headers.host ?? '')
    if (!allowedHost(src, host)) { json(res, 403, { error: `host ${host} is not localhost and not in PI_SUPERAGENT_PANEL_HOSTS` }); return }
    const bearer = bearerToken(req.headers)
    if (url.pathname.startsWith('/api/') && req.headers['x-superagent-request'] !== '1') { json(res, 403, { error: 'missing x-superagent-request: 1' }); return }
    // 401 with Basic, because a plain navigation can carry no other credential.
    if (src.config.panelTokenAllRequests && (!src.token || bearer !== src.token())) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="superagent panel"', 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'the panel needs its token' }))
      return
    }
    if (req.method === 'POST' && src.token && bearer !== src.token()) {
      json(res, 403, { error: 'a POST needs the panel token in x-superagent-token' }); return
    }
    const m = readModel(src)
    if (url.pathname === '/api/state') return json(res, 200, { paused: m.paused, load: m.load, counts: m.counts, health: m.health, workers: m.workers })
    if (url.pathname === '/api/settings') return json(res, 200, { policyVersion: m.policy.version, paused: m.paused, revision: 1 })
    if (url.pathname === '/api/sources') return json(res, 200, [{ id: 'github', state: m.source.repo ? 'ready' : 'off', stats: { triggers24h: m.counts.triggers24h, filtered24h: m.counts.filtered24h } }])
    if (url.pathname === '/api/tickets') return json(res, 200, m.open)
    if (url.pathname === '/api/decisions') return json(res, 200, m.recentDecisions)
    if (url.pathname === '/api/executor/pause' && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        // An unparseable body is the caller's mistake, not the router's: this handler runs outside the
        // request's try, so a throw here is an uncaught exception and the process dies with the panel's workers.
        let paused: boolean
        try { paused = Boolean(JSON.parse(body || '{}').paused) } catch { return json(res, 400, { error: 'body must be JSON, e.g. {"paused":true}' }) }
        src.setPaused(paused)
        json(res, 200, { paused })
      })
      return
    }
    const ticket = url.searchParams.get('id')
    const stopping = /^\/api\/tickets\/([^/]+)\/stop$/.exec(url.pathname)
    if (stopping && req.method === 'POST') {
      const id = decodeURIComponent(stopping[1]!)
      if (!src.repos.tickets.get(id)) return json(res, 404, { error: 'no such ticket' })
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        // A body the caller cannot format is the caller's mistake, and the stop is what was asked for: the
        // default reason stands, because refusing a stop over a broken string would put the lever out of reach.
        let reason = 'stopped by the operator'
        try { reason = String(JSON.parse(body || '{}').reason || reason).slice(0, 400) } catch { /* the default */ }
        try {
          src.engine.stopTicket(id, reason)
          json(res, 200, { stopped: id, reason })
        } catch (error) {
          json(res, 409, { error: String(error instanceof Error ? error.message : error) })
        }
      })
      return
    }
    // Stop a ticket waiting on one pull request, for the state no read of GitHub can ever report fixed: it sits in a repository this account cannot write to, so it stays open. `POST {"thread":"o/r#14","reason":"..."}`.
    const abandoning = /^\/api\/tickets\/([^/]+)\/abandon$/.exec(url.pathname)
    if (abandoning && req.method === 'POST') {
      const id = decodeURIComponent(abandoning[1]!)
      if (!src.repos.tickets.get(id)) return json(res, 404, { error: 'no such ticket' })
      void readBody(req).then(raw => {
        // Named the way a person names a pull request, because that is what they have on screen: `#14`, `o/r#14`, its URL.
        let names = '', reason = 'abandoned by the operator'
        try {
          const body = JSON.parse(raw || '{}')
          names = String(body.thread ?? body.pull ?? '').trim()
          reason = String(body.reason || reason).slice(0, 400)
        } catch { return json(res, 400, { error: 'body must be JSON, e.g. {"thread":"o/r#14","reason":"the fork is archived"}' }) }
        const home = src.config.githubRepo ?? ''
        const pull = parsePull(names) ?? parseThread(names, home)
        if (!pull) return json(res, 400, { error: `thread must name a pull request: #14, o/r#14, or its URL (got "${names.slice(0, 80)}")` })
        const thread = `github:${threadOfPull(pull, home).id}`
        try {
          const ticket = src.engine.abandonPull(id, thread, reason)
          src.log('info', 'panel.pull_abandoned', { ticket: id, thread, reason })
          json(res, 200, { abandoned: thread, reason, ended: ticket.ended ?? null })
        } catch (error) {
          json(res, 409, { error: String(error instanceof Error ? error.message : error) })
        }
      })
      return
    }
    if (url.pathname === '/api/ticket' && ticket) return json(res, 200, src.repos.tickets.get(ticket) ?? { error: 'no such ticket' })
    if (url.pathname === '/ticket' && ticket) {
      const t = src.repos.tickets.get(ticket)
      return void res.writeHead(200, { 'content-type': 'text/html' }).end(page(`ticket ${ticket}`, t ? `<pre>${esc(JSON.stringify(t, null, 2))}</pre>` : 'no such ticket'))
    }
    if (url.pathname === '/api/worker') {
      if (!src.workerPane) return json(res, 501, { error: 'these workers do not run in herdr tabs' })
      const t = url.searchParams.get('ticket') ?? ''
      const lines = Math.min(500, Math.max(10, Number(url.searchParams.get('lines')) || 80))
      void src.workerPane(t, lines)
        .then(w => json(res, 200, { ticket: t, ...w }))
        .catch(error => json(res, /no worker/.test(String(error)) ? 404 : 502, { error: String(error instanceof Error ? error.message : error) }))
      return
    }
    // Typing into a worker is a shell on this machine, so these ride the same POST token as the stop route.
    if ((url.pathname === '/api/worker/prompt' || url.pathname === '/api/worker/keys') && req.method === 'POST') {
      const promptRoute = url.pathname.endsWith('/prompt')
      if (!(promptRoute ? src.workerPrompt : src.workerKeys)) return json(res, 501, { error: 'these workers do not run in herdr tabs' })
      void readBody(req).then(async raw => {
        let body: { ticket?: unknown; text?: unknown; keys?: unknown }
        try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { error: 'body must be JSON' }) }
        const t = String(body.ticket ?? '')
        const text = String(body.text ?? '').slice(0, 8000)
        const keys = Array.isArray(body.keys) ? body.keys.slice(0, 16).map(k => String(k).slice(0, 16)) : []
        if (promptRoute && !text.trim()) return json(res, 400, { error: 'text is required' })
        if (!promptRoute && keys.length === 0) return json(res, 400, { error: 'keys is required' })
        try {
          if (promptRoute) await src.workerPrompt!(t, text)
          else await src.workerKeys!(t, keys)
          json(res, 200, { sent: promptRoute ? text.length : keys.length })
        } catch (error) {
          json(res, /no worker/.test(String(error)) ? 404 : 502, { error: String(error instanceof Error ? error.message : error) })
        }
      })
      return
    }
    if (url.pathname === '/worker') {
      return void res.writeHead(200, { 'content-type': 'text/html' })
        .end(workerPage(url.searchParams.get('ticket') ?? '', Boolean(src.workerPrompt)))
    }
    if (url.pathname === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(renderPanel(m))
    json(res, 404, { error: 'not found' })
  }
  const server = createServer((req, res) => {
    try {
      serve(req, res)
    } catch (error) {
      // A read that fails is a failed page, not a dead router: the panel runs in the router's process, and on
      // 2026-11-11 a full /tmp made one page view throw SQLITE_FULL and stopped the whole fleet.
      src.log('error', 'panel.failed', { path: req.url ?? '/', error: String(error).slice(0, 200) })
      if (res.headersSent) res.end()
      else json(res, 500, { error: 'the panel could not read the router state; the router is still running' })
    }
  })
  return { server, url: port => `http://127.0.0.1:${port}` }
}
