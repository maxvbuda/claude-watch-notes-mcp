// Minimal ntfy-compatible relay for tests: publish, JSON streaming/poll with `since`,
// keepalives, and the 4 KB attachment cutover. Exposes knobs to simulate failures.
//
//   import { startMock } from './mock-ntfy.mjs'   // in tests
//   node test/mock-ntfy.mjs 8799                    // standalone (for the watch simulator tests)

import crypto from 'node:crypto'
import http from 'node:http'

export async function startMock({ port = 0, keepaliveMs = 30_000 } = {}) {
  const topics = new Map() // topic -> [event]
  const files = new Map()
  const streams = new Set() // { topic, res }
  let failPublishes = 0
  let stalled = false

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts[0] === 'file' && req.method === 'GET') {
      const f = files.get(parts[1])
      if (!f) return res.writeHead(404).end()
      return res.writeHead(200, { 'content-type': 'text/plain' }).end(f)
    }

    if (parts[0] === '_control' && parts[1] === 'fail') { // lets the watch tests inject relay errors
      failPublishes = Number(parts[2]) || 0
      return res.writeHead(200).end('ok')
    }

    const topic = parts[0]
    if (!topic || !/^[-\w]{1,64}$/.test(topic)) return res.writeHead(400).end()

    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      if (failPublishes > 0) { failPublishes--; return res.writeHead(500).end('{"error":"injected"}') }
      const body = Buffer.concat(chunks)
      const id = crypto.randomBytes(6).toString('base64url')
      const ev = { id, time: Math.floor(Date.now() / 1000), event: 'message', topic }
      if (body.length >= 4096) {
        files.set(`${id}.txt`, body)
        ev.message = 'You received a file: attachment.txt'
        ev.attachment = { name: 'attachment.txt', size: body.length, url: `${base}/file/${id}.txt` }
      } else {
        ev.message = body.toString('utf8')
      }
      ev._seq = seq++
      if (!topics.has(topic)) topics.set(topic, [])
      topics.get(topic).push(ev)
      for (const s of streams) if (s.topic === topic && !stalled) write(s.res, ev)
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(strip(ev)))
    }

    if (req.method === 'GET' && parts[1] === 'json') {
      const cached = select(topics.get(topic) || [], url.searchParams.get('since'))
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (url.searchParams.get('poll') === '1') {
        for (const ev of cached) write(res, ev)
        return res.end()
      }
      const s = { topic, res }
      streams.add(s)
      write(res, { id: 'open', time: now(), event: 'open', topic })
      for (const ev of cached) write(res, ev)
      const ka = setInterval(() => { if (!stalled) write(res, { id: 'ka', time: now(), event: 'keepalive', topic }) }, keepaliveMs)
      req.on('close', () => { clearInterval(ka); streams.delete(s) })
      return
    }
    res.writeHead(404).end()
  })

  let seq = 0
  const now = () => Math.floor(Date.now() / 1000)
  const strip = ({ _seq, ...ev }) => ev
  const write = (res, ev) => res.write(JSON.stringify(strip(ev)) + '\n')
  function select(list, since) {
    if (!since || since === 'all') return list
    if (/^\d+$/.test(since)) return list.filter(e => e.time >= Number(since))
    const dur = /^(\d+)([smhd])$/.exec(since)
    if (dur) {
      const sec = Number(dur[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[dur[2]]
      return list.filter(e => e.time >= now() - sec)
    }
    const i = list.findIndex(e => e.id === since)
    return i >= 0 ? list.slice(i + 1) : list
  }

  await new Promise(r => server.listen(port, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    url: base,
    /** Close every open subscription (like a relay restart or network change). */
    dropStreams() { for (const s of streams) s.res.destroy(); streams.clear() },
    /** Keep connections open but stop sending anything, including keepalives. */
    stall(on = true) { stalled = on },
    failNextPublishes(n) { failPublishes = n },
    messages(topic) { return (topics.get(topic) || []).map(strip) },
    streamCount(topic) { return [...streams].filter(s => s.topic === topic).length },
    close() {
      for (const s of streams) s.res.destroy()
      const closed = new Promise(r => server.close(r))
      server.closeAllConnections()
      return closed
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({ port: Number(process.argv[2]) || 8799 })
  console.log(`mock ntfy on ${m.url}`)
}
