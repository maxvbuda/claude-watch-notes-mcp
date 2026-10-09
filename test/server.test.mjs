// End-to-end tests for plugin/server/handoff.mjs against a mock ntfy relay.
// Run: node --test test/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { startMock } from './mock-ntfy.mjs'

const SERVER = new URL('../plugin/server/handoff.mjs', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- the watch side, mirroring App.swift (CryptoKit AES.GCM combined, base64) ----
function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(typeof obj === 'string' ? obj : JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}
function openBox(b64, key) {
  const b = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString())
}
const post = (url, body) => fetch(url, { method: 'POST', body }).then(r => r.json())
const note = (text, extra = {}) => ({ id: crypto.randomUUID().toUpperCase(), t: text, ts: new Date().toISOString(), ...extra })

let mock
const spawned = new Set()
before(async () => { mock = await startMock({ keepaliveMs: 300 }) })
after(() => { for (const p of spawned) p.kill(); return mock.close() })

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-')) }
function pairDir(dir, topic = `cw-${crypto.randomBytes(16).toString('hex')}`) {
  const key = crypto.randomBytes(32)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ topicURL: `${mock.url}/${topic}`, key: key.toString('base64') }))
  return { key, topicURL: `${mock.url}/${topic}`, topic }
}

/** Spawns the MCP server; collects JSON-RPC output. */
function startServer(dir, { init = true, env = {} } = {}) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_IDLE_MS: '1500', CLAUDE_WATCH_NOTES_CHANNEL: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  spawned.add(p)
  const msgs = []
  let stderr = ''
  let buf = ''
  p.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  p.stderr.on('data', d => { stderr += d })
  let nextId = 100
  const s = {
    p, msgs,
    get stderr() { return stderr },
    send(m) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n') },
    raw(text) { p.stdin.write(text) },
    async waitFor(pred, ms = 5000, what = 'message') {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const m = msgs.find(pred)
        if (m) return m
        await sleep(25)
      }
      throw new Error(`timed out waiting for ${what}\nstdout: ${JSON.stringify(msgs)}\nstderr: ${stderr}`)
    },
    async request(method, params) {
      const id = nextId++
      s.send({ id, method, params })
      return s.waitFor(m => m.id === id, 5000, method)
    },
    pushes() { return msgs.filter(m => m.method === 'notifications/claude/channel') },
    async init() {
      const r = await s.request('initialize', { protocolVersion: '2025-06-18' })
      s.send({ method: 'notifications/initialized' })
      return r
    },
    async stop() { p.stdin.end(); await new Promise(r => p.exitCode !== null ? r() : p.on('exit', r)) },
  }
  if (init) s.ready = s.init()
  return s
}

async function connected(topic, n = 1) {
  const end = Date.now() + 5000
  while (mock.streamCount(topic) < n) {
    if (Date.now() > end) throw new Error('server never subscribed')
    await sleep(20)
  }
}
const pushFor = id => m => m.method === 'notifications/claude/channel' && m.params.meta.note_id === id

describe('MCP protocol', () => {
  let dir, s
  before(async () => { dir = tmpDir(); pairDir(dir); s = startServer(dir, { init: false }) })
  after(() => s.stop())

  test('initialize declares the channel capability and instructions', async () => {
    const r = await s.request('initialize', { protocolVersion: '2025-03-26' })
    assert.equal(r.result.protocolVersion, '2025-03-26')
    assert.deepEqual(r.result.capabilities.experimental, { 'claude/channel': {} })
    assert.ok(r.result.capabilities.tools)
    assert.match(r.result.instructions, /watch_note_done/)
    assert.match(r.result.instructions, /blocked/)
    s.send({ method: 'notifications/initialized' })
  })

  test('tools/list exposes inbox and done', async () => {
    const r = await s.request('tools/list')
    assert.deepEqual(r.result.tools.map(t => t.name).sort(), ['watch_inbox', 'watch_note_done'])
  })

  test('ping', async () => assert.deepEqual((await s.request('ping')).result, {}))

  test('unknown method -> -32601', async () => assert.equal((await s.request('resources/list')).error.code, -32601))

  test('malformed JSON is ignored and the server keeps working', async () => {
    s.raw('{not json\n\n   \n')
    assert.deepEqual((await s.request('ping')).result, {})
    assert.match(s.stderr, /bad message/)
  })

  test('messages split across writes and batched in one write', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    s.raw(line.slice(0, 10)); await sleep(30); s.raw(line.slice(10) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n')
    await s.waitFor(m => m.id === 1); await s.waitFor(m => m.id === 2)
  })

  test('unknown tool -> isError', async () => {
    const r = await s.request('tools/call', { name: 'nope', arguments: {} })
    assert.equal(r.result.isError, true)
  })

  test('watch_note_done with unknown or hostile id is a clean error and touches nothing', async () => {
    const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8')
    for (const note_id of ['missing', '../config', '../../etc/passwd', '']) {
      const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id, summary: 'x' } })
      assert.equal(r.result.isError, true, note_id)
      assert.match(r.result.content[0].text, /No watch note/)
    }
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before)
  })

  test('watch_inbox when empty', async () => {
    const r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.equal(r.result.content[0].text, 'No pending watch notes.')
  })
})

describe('delivery', () => {
  let dir, s, cfg
  before(async () => { dir = tmpDir(); cfg = pairDir(dir); s = startServer(dir); await s.ready; await connected(cfg.topic) })
  after(() => s.stop())

  test('an encrypted note is pushed into the session and saved', async () => {
    const n = note('Add dark mode to settings\nuse system colors')
    await post(cfg.topicURL, seal(n, cfg.key))
    const m = await s.waitFor(pushFor(n.id))
    assert.equal(m.params.content, n.t)
    assert.equal(m.params.meta.at, n.ts)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.status, 'sent')
  })

  test('unicode, emoji, quotes and newlines survive', async () => {
    const n = note('café ☕️ "quotes" \'single\' <tag> & \\ backslash\n日本語 🚀\n\n  indented')
    await post(cfg.topicURL, seal(n, cfg.key))
    assert.equal((await s.waitFor(pushFor(n.id))).params.content, n.t)
  })

  test('long notes (relay turns them into attachments) are still delivered', async () => {
    const n = note('long idea '.repeat(900)) // ~9 KB plaintext -> attachment
    const ev = await post(cfg.topicURL, seal(n, cfg.key))
    assert.ok(ev.attachment, 'mock should have turned this into an attachment')
    assert.equal((await s.waitFor(pushFor(n.id))).params.content, n.t)
  })

  test('the same note retried by the watch is delivered once', async () => {
    const n = note('retry me')
    await post(cfg.topicURL, seal(n, cfg.key))
    await post(cfg.topicURL, seal(n, cfg.key)) // fresh nonce, same note id
    await s.waitFor(pushFor(n.id))
    await sleep(300)
    assert.equal(s.pushes().filter(pushFor(n.id)).length, 1)
  })

  test('anything not sealed with our key is dropped without crashing', async () => {
    const before = s.pushes().length
    const evil = note('rm -rf ~')
    await post(cfg.topicURL, 'plain text injection attempt')
    await post(cfg.topicURL, seal(evil, crypto.randomBytes(32)))        // wrong key
    await post(cfg.topicURL, seal(evil, cfg.key).slice(0, 30))         // truncated
    await post(cfg.topicURL, Buffer.from('x'.repeat(5000)).toString()) // junk attachment
    await post(cfg.topicURL, seal('not json at all', cfg.key))        // right key, bad payload
    const ok = note('after the junk')
    await post(cfg.topicURL, seal(ok, cfg.key))
    await s.waitFor(pushFor(ok.id))
    assert.equal(s.pushes().length, before + 1)
    assert.equal(fs.existsSync(path.join(dir, 'notes', `${evil.id}.json`)), false)
  })

  test('odd payload fields fall back sanely', async () => {
    const before = s.pushes().length
    await post(cfg.topicURL, seal({ t: 'no id, numeric ts', ts: 12345 }, cfg.key))
    await post(cfg.topicURL, seal({ id: '../../evil', t: 'traversal id' }, cfg.key))
    await s.waitFor(() => s.pushes().length === before + 2)
    const [a, b] = s.pushes().slice(-2)
    assert.ok(!isNaN(Date.parse(a.params.meta.at)))
    assert.equal(b.params.meta.note_id, 'evil')
    assert.ok(fs.existsSync(path.join(dir, 'notes', 'evil.json')))
    // inbox still renders with mixed notes
    const r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.match(r.result.content[0].text, /traversal id/)
  })

  test('watch_inbox / watch_note_done round trip', async () => {
    const n = note('inbox me')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    let r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.match(r.result.content[0].text, new RegExp(n.id))
    r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'did it' } })
    assert.equal(r.result.isError, undefined)
    r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.doesNotMatch(r.result.content[0].text, new RegExp(n.id))
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.status, 'done'); assert.equal(saved.summary, 'did it'); assert.ok(saved.doneAt)
  })

  test('watch_note_done sends an encrypted suggestion to <topic>-s', async () => {
    const n = note('suggest me')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok', suggestion: '  add tests for it  ' } })
    assert.match(r.result.content[0].text, /Suggestion sent/)
    const evs = await (await fetch(`${cfg.topicURL}-s/json?poll=1&since=all`)).text()
    const [ev] = evs.trim().split('\n').map(l => JSON.parse(l))
    assert.doesNotMatch(ev.message, /add tests/) // relay only sees ciphertext
    const got = openBox(ev.message, cfg.key)
    assert.equal(got.s, 'add tests for it'); assert.equal(got.note, n.id)
    assert.equal(typeof got.chat, 'string')
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.suggestion, 'add tests for it')
  })

  test('a burst of 30 notes all arrive, in order', async () => {
    const ns = Array.from({ length: 30 }, (_, i) => note(`burst ${i}`))
    for (const n of ns) await post(cfg.topicURL, seal(n, cfg.key))
    for (const n of ns) await s.waitFor(pushFor(n.id))
    const order = s.pushes().filter(m => m.params.content.startsWith('burst ')).map(m => m.params.content)
    assert.deepEqual(order, ns.map(n => n.t))
  })
})

describe('sessions, restarts and the network', () => {
  test('only the channel session claims notes; other open sessions leave them alone', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const other = startServer(dir, { env: { CLAUDE_WATCH_NOTES_CHANNEL: '' } }) // e.g. a `claude --resume` window
    await other.ready; await connected(cfg.topic)
    const n = note('for the channel session')
    await post(cfg.topicURL, seal(n, cfg.key))
    await sleep(800)
    assert.equal(other.pushes().length, 0)
    const r = await other.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.match(r.result.content[0].text, new RegExp(n.id)) // still reachable from /handoff:inbox
    const listening = startServer(dir)
    await listening.waitFor(pushFor(n.id))
    await Promise.all([other.stop(), listening.stop()])
  })

  test('the listening session gets a note even when another session saves it to disk first', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const others = [1, 2, 3].map(() => startServer(dir, { env: { CLAUDE_WATCH_NOTES_CHANNEL: '' } }))
    const listening = startServer(dir)
    await Promise.all([...others, listening].map(x => x.ready)); await connected(cfg.topic, 4)
    const ns = Array.from({ length: 10 }, (_, i) => note(`race ${i}`))
    for (const n of ns) await post(cfg.topicURL, seal(n, cfg.key))
    for (const n of ns) await listening.waitFor(pushFor(n.id))
    assert.equal(listening.pushes().length, 10)
    await Promise.all([...others, listening].map(x => x.stop()))
  })

  test('safety net: takes back notes held by non-listening sessions, not by listeners', async () => {
    const dir = tmpDir(); pairDir(dir)
    const notes = path.join(dir, 'notes'); fs.mkdirSync(notes, { recursive: true })
    const held = (text, claim, ageMs = 0) => {
      const n = { id: crypto.randomUUID().toUpperCase(), text, at: new Date().toISOString(), status: 'sent' }
      fs.writeFileSync(path.join(notes, `${n.id}.json`), JSON.stringify(n))
      const f = path.join(notes, `${n.id}.claim`)
      fs.writeFileSync(f, claim)
      if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t) }
      return n
    }
    const dead = spawn(process.execPath, ['-e', '']); await new Promise(r => dead.on('exit', r))
    const exited = held('held by an exited old-version session', String(dead.pid))
    const exitedListener = held('held by an exited listener', `${dead.pid} channel`)
    const oldVersion = held('held by an old-version session', String(process.pid), 5 * 60_000)
    const fresh = held('just taken by an old-version session', String(process.pid))
    const listener = held('held by a live listener', `${process.pid} channel`)
    const done = held('already done', `${dead.pid} channel`)
    fs.writeFileSync(path.join(notes, `${done.id}.json`), JSON.stringify({ ...done, status: 'done' }))

    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_SWEEP_MS: '200' } })
    await s.ready
    await s.waitFor(pushFor(exited.id)); await s.waitFor(pushFor(oldVersion.id))
    // Rescued exactly once, even though the sweep keeps running.
    await sleep(800)
    for (const n of [exited, oldVersion]) assert.equal(s.pushes().filter(m => m.params.meta.note_id === n.id).length, 1)
    for (const n of [fresh, listener, exitedListener, done]) assert.equal(s.pushes().filter(m => m.params.meta.note_id === n.id).length, 0, n.text)
    assert.ok(fs.existsSync(path.join(notes, `${exited.id}.claim.1`)))
    await s.stop()
  })

  test('chats: a note sent to a chat by name only goes to that chat; untargeted notes go to any', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const web = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website' } })
    const app = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'app' } })
    await Promise.all([web.ready, app.ready]); await connected(cfg.topic, 2)
    const toApp = note('for app', { to: 'app' }), toWeb = note('for website', { to: 'website' }), any = note('for anyone')
    const toGone = note('for a chat that is not open', { to: 'closed' })
    for (const n of [toApp, toWeb, any, toGone]) await post(cfg.topicURL, seal(n, cfg.key))
    await app.waitFor(pushFor(toApp.id)); await web.waitFor(pushFor(toWeb.id))
    await sleep(500)
    assert.equal(web.pushes().filter(pushFor(toApp.id)).length, 0)
    assert.equal(app.pushes().filter(pushFor(toWeb.id)).length, 0)
    assert.equal([...web.pushes(), ...app.pushes()].filter(pushFor(any.id)).length, 1)
    assert.equal([...web.pushes(), ...app.pushes()].filter(pushFor(toGone.id)).length, 0)
    // It waits for that chat: delivered when a session with that name starts.
    const closed = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'closed' } })
    await closed.waitFor(pushFor(toGone.id))
    await Promise.all([web.stop(), app.stop(), closed.stop()])
  })

  test('chats: listening sessions announce their name (sealed) and say goodbye on exit', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const quiet = startServer(dir, { env: { CLAUDE_WATCH_NOTES_CHANNEL: '', CLAUDE_WATCH_NOTES_NAME: 'not listening' } })
    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website', CLAUDE_WATCH_NOTES_HEARTBEAT_MS: '300' } })
    await Promise.all([quiet.ready, s.ready])
    const chats = async () => (await (await fetch(`${cfg.topicURL}-c/json?poll=1&since=all`)).text())
      .trim().split('\n').filter(Boolean).map(l => openBox(JSON.parse(l).message, cfg.key))
    const end = Date.now() + 5000
    while ((await chats()).length < 3 && Date.now() < end) await sleep(100)
    let got = await chats()
    assert.ok(got.length >= 3, 'initial + periodic heartbeats')
    assert.ok(got.every(c => c.chat === 'website' && !c.gone))
    await s.stop(); await quiet.stop()
    got = await chats()
    assert.equal(got.at(-1).gone, true)
    assert.equal(got.filter(c => c.chat !== 'website').length, 0)
  })

  test('notes that arrive before the session is ready are pushed on initialize', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir, { init: false })
    await connected(cfg.topic)
    const n = note('early bird')
    await post(cfg.topicURL, seal(n, cfg.key))
    await sleep(300)
    assert.equal(s.pushes().length, 0)
    await s.init()
    await s.waitFor(pushFor(n.id))
    await s.stop()
  })

  test('notes sent while no session was running are delivered when one starts', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const n = note('sent while away')
    await post(cfg.topicURL, seal(n, cfg.key))
    const s = startServer(dir)
    await s.waitFor(pushFor(n.id))
    await s.stop()
  })

  for (let run = 1; run <= Number(process.env.RACE_RUNS || 10); run++)
  test(`two sessions at once: every note is handed to exactly one (run ${run})`, async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const a = startServer(dir), b = startServer(dir)
    await Promise.all([a.ready, b.ready]); await connected(cfg.topic, 2)
    const ns = Array.from({ length: 20 }, (_, i) => note(`shared ${i}`))
    for (const n of ns) await post(cfg.topicURL, seal(n, cfg.key))
    const end = Date.now() + 5000
    while (a.pushes().length + b.pushes().length < 20 && Date.now() < end) await sleep(50)
    await sleep(500)
    for (const n of ns) {
      const count = [...a.pushes(), ...b.pushes()].filter(pushFor(n.id)).length
      assert.equal(count, 1, `${n.t} delivered ${count} times`)
    }
    await a.stop(); await b.stop()
  })

  test('restart does not re-deliver handled notes', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    let s = startServer(dir); await s.ready; await connected(cfg.topic)
    const n = note('once only')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id)); await s.stop()
    s = startServer(dir); await s.ready; await connected(cfg.topic)
    const n2 = note('after restart')
    await post(cfg.topicURL, seal(n2, cfg.key))
    await s.waitFor(pushFor(n2.id))
    assert.equal(s.pushes().filter(pushFor(n.id)).length, 0)
    await s.stop()
  })

  test('relay drops the connection: server reconnects and catches up', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir); await s.ready; await connected(cfg.topic)
    mock.dropStreams()
    const n = note('sent during the outage') // posted before the server reconnects
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id), 8000)
    await s.stop()
  })

  test('silent stall (no bytes, no close): watchdog reconnects', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir); await s.ready; await connected(cfg.topic)
    mock.stall(true)
    const n = note('sent while the connection was wedged')
    await post(cfg.topicURL, seal(n, cfg.key)) // not forwarded on the stalled stream
    await sleep(2000) // > CLAUDE_WATCH_NOTES_IDLE_MS
    mock.stall(false)
    await s.waitFor(pushFor(n.id), 8000)
    assert.match(s.stderr, /connection idle/)
    await s.stop()
  })

  test('relay unreachable at start, then comes up', async () => {
    const dir = tmpDir()
    const down = await startMock(); const downURL = down.url; await down.close()
    const key = crypto.randomBytes(32); const topic = `cw-${crypto.randomBytes(16).toString('hex')}`
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ topicURL: `${downURL}/${topic}`, key: key.toString('base64') }))
    const s = startServer(dir); await s.ready
    await sleep(1500)
    const up = await startMock({ port: Number(new URL(downURL).port) })
    const n = note('relay is back')
    await post(`${downURL}/${topic}`, seal(n, key))
    await s.waitFor(pushFor(n.id), 10000)
    assert.match(s.stderr, /subscription:/)
    await s.stop(); await up.close()
  })

  test('not paired at start; pairing later is picked up without restart', async () => {
    const dir = tmpDir()
    const s = startServer(dir); await s.ready
    await sleep(300)
    assert.match(s.stderr, /not paired yet/)
    const cfg = pairDir(dir)
    await connected(cfg.topic)
    const n = note('first note after pairing')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id), 8000)
    await s.stop()
  })

  test('re-pairing switches topic and key live; the old pairing stops working', async () => {
    const dir = tmpDir(); const old = pairDir(dir)
    const s = startServer(dir); await s.ready; await connected(old.topic)
    const fresh = pairDir(dir)
    await connected(fresh.topic)
    const stale = note('old pairing'); const good = note('new pairing')
    await post(old.topicURL, seal(stale, old.key))
    await post(fresh.topicURL, seal(good, fresh.key))
    await s.waitFor(pushFor(good.id), 8000)
    await sleep(300)
    assert.equal(s.pushes().filter(pushFor(stale.id)).length, 0)
    assert.ok(fs.readFileSync(path.join(dir, 'cursor'), 'utf8').startsWith(fresh.topicURL))
    await s.stop()
  })
})

describe('host command (new chats from the watch)', () => {
  const CLI = new URL('../cli/handoff.mjs', import.meta.url).pathname
  test('lists projects, opens only listed ones, ignores stale/forged requests, quotes names safely', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-root-')))
    for (const d of ['website', 'app', '.hidden', 'website/src', 'website/src/deep', 'website/node_modules']) fs.mkdirSync(path.join(root, d))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-outside-'))
    fs.symlinkSync(outside, path.join(root, 'escape-link'))
    fs.symlinkSync(path.join(root, 'app'), path.join(root, 'app-link'))
    fs.writeFileSync(path.join(root, 'notes.txt'), '')
    const h = spawn(process.execPath, [CLI, 'host', root], {
      env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1' },
    })
    spawned.add(h)
    let out = ''
    h.stdout.on('data', d => { out += d })
    const announced = async () => (await (await fetch(`${cfg.topicURL}-c/json?poll=1&since=all`)).text())
      .trim().split('\n').filter(Boolean).map(l => openBox(JSON.parse(l).message, cfg.key))
    let end = Date.now() + 5000
    while (!(await announced()).length && Date.now() < end) await sleep(50)
    const [a] = await announced()
    assert.deepEqual(a.projects, ['app', 'app-link', 'website']) // symlinks only when they stay inside
    assert.equal(typeof a.host, 'string')
    await connected(`${cfg.topic}-n`)

    const ask = (r, key = cfg.key) => post(`${cfg.topicURL}-n`, seal({ ts: new Date().toISOString(), ...r }, key))
    const evil = "it's $(touch pwned) `x` \"q\""
    await ask({ project: '../..', name: 'escape' })
    await ask({ project: 'website', name: 'stale', ts: new Date(Date.now() - 11 * 60_000).toISOString() })
    await ask({ project: 'website', name: 'forged' }, crypto.randomBytes(32))
    await ask({ path: 'escape-link', name: 'symlink escape' })
    await ask({ path: 'website', create: '../breakout', name: 'bad folder' })
    await ask({ project: 'website', name: evil }) // the old watch build's field
    await ask({ path: 'website/src/deep', name: 'deep' })
    await ask({ path: 'website/src', create: 'made-on-watch' })
    end = Date.now() + 5000
    while ((out.match(/^LAUNCH/gm) || []).length < 3 && Date.now() < end) await sleep(50)
    await sleep(300)
    const launches = [...out.matchAll(/^LAUNCH (.*)$/gm)].map(m => JSON.parse(m[1]))
    assert.deepEqual(launches.map(l => [l.dir, l.name]), [
      [path.join(root, 'website'), evil],
      [path.join(root, 'website/src/deep'), 'deep'],
      [path.join(root, 'website/src/made-on-watch'), 'made-on-watch'],
    ], out)
    assert.ok(fs.statSync(path.join(root, 'website/src/made-on-watch')).isDirectory())
    assert.ok(!fs.existsSync(path.join(root, 'breakout')) && !fs.existsSync(path.join(root, 'website/breakout')))

    // Folder browsing: listings come back sealed on "<topic>-l"; paths outside the root get none.
    const lsReply = async (ls) => {
      const id = crypto.randomUUID()
      await ask({ ls, id })
      const stop = Date.now() + 5000
      while (Date.now() < stop) {
        const got = (await (await fetch(`${cfg.topicURL}-l/json?poll=1&since=all`)).text()).trim().split('\n').filter(Boolean)
          .map(l => openBox(JSON.parse(l).message, cfg.key)).find(m => m.id === id)
        if (got) return got
        await sleep(50)
      }
      throw new Error('no listing reply')
    }
    assert.deepEqual((await lsReply('')).dirs, ['app', 'app-link', 'website'])
    assert.deepEqual((await lsReply('website')).dirs, ['src']) // node_modules hidden
    assert.deepEqual((await lsReply('website/src')).dirs, ['deep', 'made-on-watch'])
    assert.equal((await lsReply('../')).dirs, null)
    assert.equal((await lsReply('escape-link')).dirs, null)
    // The log window's script quotes the name and log path: running it with the name runs no command.
    const { execFileSync } = await import('node:child_process')
    const title = launches[0].script.match(/^printf '\\033\]0;%s\\007' (.*)$/m)[1]
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${title}`], { cwd: root }).toString(), `Handoff: ${evil}`)
    assert.match(launches[0].script, /tail -n \+1 -F '[^'$`"]+\.log'\n$/)
    assert.ok(!fs.existsSync(path.join(root, 'pwned')))
    assert.deepEqual((await announced()).at(-1).chats.sort(), [evil, 'deep', 'made-on-watch'].sort())

    h.kill('SIGTERM'); await new Promise(r => h.on('exit', r))
    assert.equal((await announced()).at(-1).gone, true)
  })

  test('runs notes for its chats headless, one at a time, continuing the same session', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-root-')))
    fs.mkdirSync(path.join(root, 'website'))
    const calls = path.join(dir, 'fake-claude.jsonl')
    const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1',
      CLAUDE_WATCH_NOTES_CLAUDE: new URL('./fake-claude.mjs', import.meta.url).pathname, FAKE_CLAUDE_LOG: calls,
      CLAUDE_WATCH_NOTES_SWEEP_MS: '200', CLAUDE_WATCH_NOTES_CHANNEL: '1' }
    let h = spawn(process.execPath, [CLI, 'host', root], { env })
    spawned.add(h)
    let out = ''
    h.stdout.on('data', d => { out += d })
    await connected(`${cfg.topic}-n`); await connected(cfg.topic)
    await post(`${cfg.topicURL}-n`, seal({ ts: new Date().toISOString(), path: 'website', name: 'web' }, cfg.key))
    let end = Date.now() + 5000
    while (!out.includes('LAUNCH') && Date.now() < end) await sleep(50)
    const { session } = JSON.parse(out.match(/^LAUNCH (.*)$/m)[1])

    const ran = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
    const saved = id => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${id}.json`), 'utf8')) } catch { return {} } }
    const until = async (cond, what) => { const stop = Date.now() + 8000; while (!cond()) { if (Date.now() > stop) throw new Error(`timed out: ${what}\n${out}`); await sleep(50) } }

    const first = note('-rf make a todo app', { to: 'web' }), second = note('add dark mode', { to: 'web' })
    const other = note('not for the host', { to: 'some other chat' })
    for (const n of [first, second, other]) await post(cfg.topicURL, seal(n, cfg.key))
    await until(() => ran().length >= 2 && saved(second.id).status === 'done', 'both notes run')
    const [a, b] = ran()
    assert.equal(a.cwd, path.join(root, 'website'))
    assert.equal(a.name, 'web')
    assert.ok(a.args.includes('-p') && a.args.includes('--permission-mode') && a.args.includes('auto'))
    assert.deepEqual(a.args.slice(a.args.indexOf('--session-id'), a.args.indexOf('--session-id') + 2), ['--session-id', session])
    assert.deepEqual(b.args.slice(b.args.indexOf('--resume'), b.args.indexOf('--resume') + 2), ['--resume', session]) // same conversation
    assert.ok(a.prompt.startsWith('-rf make a todo app') && a.prompt.includes(`note_id=${first.id}`)) // prompt on stdin, not argv
    assert.ok(!a.args.some(x => x.includes('todo')))
    assert.equal(saved(first.id).summary, 'Did: -rf make a todo app') // Claude didn't call watch_note_done
    assert.equal(ran().length, 2) // the note for another chat isn't run here
    assert.equal(saved(other.id).status, 'new')
    const log = fs.readFileSync(path.join(dir, 'logs', fs.readdirSync(path.join(dir, 'logs'))[0]), 'utf8')
    assert.match(log, /Note from your watch:\n-rf make a todo app/)
    assert.match(log, /→ Bash \{"command":"ls"\}/)
    assert.match(log, new RegExp(`claude --resume ${session}`))

    // Failures are recorded, and the chat survives a host restart (it keeps resuming the session).
    const bad = note('FAIL please', { to: 'web' })
    await post(cfg.topicURL, seal(bad, cfg.key))
    await until(() => saved(bad.id).status === 'failed', 'failure recorded')
    assert.match(saved(bad.id).summary, /something broke/)
    h.kill('SIGTERM'); await new Promise(r => h.on('exit', r))
    h = spawn(process.execPath, [CLI, 'host', root], { env })
    spawned.add(h)
    await connected(cfg.topic)
    const later = note('one more thing', { to: 'web' })
    await post(cfg.topicURL, seal(later, cfg.key))
    await until(() => saved(later.id).status === 'done', 'note after restart')
    const last = ran().at(-1)
    assert.equal(last.args[last.args.indexOf('--resume') + 1], session)
    assert.equal(ran().filter(r => r.prompt.includes(first.id)).length, 1) // nothing re-run after the restart
    h.kill('SIGTERM'); await new Promise(r => h.on('exit', r))
  })
})

describe('pair command', () => {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const code = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(31)]).join('')
  const derive = (c, info, n) => Buffer.from(crypto.hkdfSync('sha256', c, 'claude-watch-notes-pair', info, n))

  function runPair(dir, c, timeoutMs = 15000) {
    const p = spawn(process.execPath, [SERVER, 'pair'], {
      env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_PAIR_CODE: c,
        CLAUDE_WATCH_NOTES_NO_SIM: '1', CLAUDE_WATCH_NOTES_PAIR_TIMEOUT_MS: String(timeoutMs) },
    })
    spawned.add(p)
    let outText = ''
    p.stdout.on('data', d => { outText += d }); p.stderr.on('data', d => { outText += d })
    return { p, get out() { return outText }, exit: new Promise(r => p.on('exit', r)) }
  }
  // What the watch does (Pairer.pair in App.swift).
  async function watchPair(c, { topic, key, n = crypto.randomBytes(16).toString('hex') } = {}) {
    const pk = derive(c, 'key', 32)
    const pairURL = `${mock.url}/cwp-${derive(c, 'topic', 16).toString('hex')}`
    topic ??= `${mock.url}/cw-${crypto.randomBytes(16).toString('hex')}`
    key ??= crypto.randomBytes(32).toString('base64')
    const offer = await post(pairURL, seal({ topic, key, n }, pk))
    for (let i = 0; i < 40; i++) {
      await sleep(100)
      const res = await (await fetch(`${pairURL}/json?poll=1&since=${offer.id}`)).text()
      for (const line of res.split('\n').filter(Boolean)) {
        try { if (openBox(JSON.parse(line).message, pk).ack === n) return { topic, key } } catch {}
      }
    }
    return null
  }

  test('pairs: writes config and acknowledges the watch', async () => {
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c)
    await sleep(300)
    assert.match(run.out, new RegExp(`${c.slice(0, 4)}-${c.slice(4)}`))
    const w = await watchPair(c)
    assert.ok(w, 'watch never got an ack')
    assert.equal(await run.exit, 0)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    assert.deepEqual(cfg, { topicURL: w.topic, key: w.key })
    assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
  })

  test('the watch posting before the Mac starts listening still pairs', async () => {
    const dir = tmpDir(); const c = code()
    const watch = watchPair(c)
    await sleep(150)
    const run = runPair(dir, c)
    assert.ok(await watch); assert.equal(await run.exit, 0)
  })

  test('rejects malformed offers and keeps waiting for a valid one', async () => {
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c)
    await sleep(300)
    const pk = derive(c, 'key', 32)
    const pairURL = `${mock.url}/cwp-${derive(c, 'topic', 16).toString('hex')}`
    const good = { topic: `${mock.url}/cw-${'a'.repeat(32)}`, key: crypto.randomBytes(32).toString('base64'), n: 'x' }
    await post(pairURL, seal({ ...good, topic: 'https://evil.example/cw-' + 'a'.repeat(32) }, pk)) // other host
    await post(pairURL, seal({ ...good, topic: `${mock.url}/cw-../../x` }, pk))                    // bad topic
    await post(pairURL, seal({ ...good, key: crypto.randomBytes(16).toString('base64') }, pk))      // short key
    await post(pairURL, seal({ ...good, n: 42 }, pk))                                                // bad nonce
    await post(pairURL, seal(good, crypto.randomBytes(32)))                                          // wrong code
    await sleep(500)
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false)
    assert.equal(run.p.exitCode, null, 'pair should still be waiting')
    assert.ok(await watchPair(c)); assert.equal(await run.exit, 0)
  })

  test('a wrong code never pairs', async () => {
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c, 2500)
    await sleep(300)
    assert.equal(await watchPair(c.replace(/^./, ch => (ch === 'A' ? 'B' : 'A'))), null)
    assert.equal(await run.exit, 1)
    assert.match(run.out, /Timed out/)
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false)
  })
})
