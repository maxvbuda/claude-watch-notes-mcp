#!/usr/bin/env node
// watch-notes: zero-dependency MCP server + Claude Code channel.
// Receives end-to-end encrypted ideas jotted on Apple Watch (relayed via ntfy)
// and pushes them into the running Claude Code session. The only thing sent back is an
// optional one-line suggested next prompt, encrypted with the same key (never Claude's response).
//
//   node watch-notes.mjs         # MCP server (Claude Code spawns this)
//   node watch-notes.mjs pair    # show a code; type it on the watch to pair
//
// This file never launches other programs. The `watch-notes` terminal command (cli/) does that.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RELAY = process.env.CLAUDE_WATCH_NOTES_RELAY || 'https://ntfy.sh' // must match Relay.base in the watch app
const DIR = process.env.CLAUDE_WATCH_NOTES_DIR || path.join(os.homedir(), '.claude-watch-notes')
const NOTES = path.join(DIR, 'notes')
const CONFIG = path.join(DIR, 'config.json')
const CURSOR = path.join(DIR, 'cursor')
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return null } }

// AES-256-GCM in CryptoKit's "combined" layout: nonce(12) | ciphertext | tag(16), base64.
function open(b64, key) {
  const b = Buffer.from(b64, 'base64')
  if (b.length < 29) throw new Error('short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8'))
}
function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}

// Yields ntfy events from a streaming JSON subscription.
// If nothing (not even a keepalive) arrives for `idleMs`, the connection is treated as dead.
async function* events(url, signal, idleMs = Number(process.env.CLAUDE_WATCH_NOTES_IDLE_MS) || 120_000) {
  const idle = new AbortController()
  let timer
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('connection idle')), idleMs) }
  kick()
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, idle.signal]) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    yield* lines(res.body, kick)
  } catch (e) {
    throw idle.signal.aborted && !signal.aborted ? idle.signal.reason : e
  } finally {
    clearTimeout(timer)
  }
}

async function* lines(body, kick) {
  const dec = new TextDecoder()
  let pending = ''
  for await (const chunk of body) {
    kick()
    pending += dec.decode(chunk, { stream: true })
    let i
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i)
      pending = pending.slice(i + 1)
      if (line) yield JSON.parse(line)
    }
  }
}

// ---------- pair ----------
// Code -> (pairing key, pairing topic) via HKDF. The watch derives the same pair,
// posts its freshly generated topic+key sealed with the pairing key, and waits for our ack.
if (process.argv[2] === 'pair') {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L
  const code = process.env.CLAUDE_WATCH_NOTES_PAIR_CODE ||
    Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
  const derive = (info, n) => Buffer.from(crypto.hkdfSync('sha256', code, 'claude-watch-notes-pair', info, n))
  const pk = derive('key', 32)
  const pairURL = `${RELAY}/cwp-${derive('topic', 16).toString('hex')}`

  console.log(`\n  Pairing code:  ${code.slice(0, 4)}-${code.slice(4)}\n\n  Open the app on your watch and enter it. Waiting up to 10 minutes…\n`)
  try {
    // The pairing topic is derived from a fresh random code, so everything on it is from this attempt.
    const timeout = AbortSignal.timeout(Number(process.env.CLAUDE_WATCH_NOTES_PAIR_TIMEOUT_MS) || 600_000)
    for await (const ev of events(`${pairURL}/json?since=all`, timeout)) {
      if (ev.event !== 'message') continue
      let p
      try { p = open(ev.message, pk) } catch { continue }
      const topicOK = typeof p.topic === 'string' && p.topic.startsWith(`${RELAY}/cw-`) &&
        /^[0-9a-f]{32}$/.test(p.topic.slice(RELAY.length + 4))
      if (typeof p.n !== 'string' || Buffer.from(String(p.key), 'base64').length !== 32 || !topicOK) continue
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(CONFIG, JSON.stringify({ topicURL: p.topic, key: p.key }, null, 2), { mode: 0o600 })
      await fetch(pairURL, { method: 'POST', body: seal({ ack: p.n }, pk) })
      console.log('  Paired. Running Claude Code sessions pick this up automatically.\n\n  Next: watch-notes start\n')
      process.exit(0)
    }
  } catch (e) {
    console.error(e.name === 'TimeoutError' ? '  Timed out. Run pair again for a new code.' : `  ${e.message}`)
  }
  process.exit(1)
}

// ---------- MCP over stdio ----------
fs.mkdirSync(NOTES, { recursive: true, mode: 0o700 })

const out = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const log = (...a) => process.stderr.write(`[watch-notes] ${a.join(' ')}\n`)
let ready = false
// Every Claude Code session with the plugin runs this server, but only the one `watch-notes start`
// opened is listening on the channel (it sets this). Others must not claim notes they'd ignore;
// they can still work through them with watch_inbox.
const CHANNEL = process.env.CLAUDE_WATCH_NOTES_CHANNEL === '1'

const INSTRUCTIONS = `Ideas the user jotted on their Apple Watch arrive from this server as <channel note_id="..." at="..."> events.
The user is away from the computer and will not see or answer questions: treat each note as a task to complete autonomously in the current project, making reasonable assumptions (write them down in your final summary). Notes are terse, dictated, and may contain transcription errors.
If an action is blocked or denied by the permission system, do not retry it or look for a way around it: skip that step, finish what you can, and list what was blocked in your summary for the user to do when they get home.
Claude's response is never sent to the watch. Every note must end with a call to watch_note_done with its note_id and a short summary, including quick questions (put the answer in the summary) and notes you decide not to act on. Answering in the terminal alone is not enough: the user isn't there, and watch_note_done is how the result is saved for them and how the suggestion reaches the watch.
You may also pass a suggestion: the one prompt the user would most likely send next, written as the user would type it (under 80 characters, e.g. "add tests for the new parser"). It appears on the watch with an Accept suggestion button that sends it back to you as a new note. Leave it out when there's no obvious next step.
If you were not started as a channel, call watch_inbox to fetch pending notes.`

const TOOLS = [
  {
    name: 'watch_inbox',
    description: 'List ideas from the Apple Watch that are not done yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'watch_note_done',
    description: 'Mark a watch note as done, with a short summary of what was done (stays on this machine).',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        summary: { type: 'string' },
        suggestion: { type: 'string', description: 'Optional: the next prompt the user would most likely send, as they would type it (under 80 characters). Shown on the watch with an Accept suggestion button.' },
      },
      required: ['note_id', 'summary'],
    },
  },
]

const noteFile = id => path.join(NOTES, `${id.replace(/[^\w-]/g, '')}.json`)
const allNotes = () => fs.readdirSync(NOTES).filter(f => f.endsWith('.json'))
  .map(f => { try { return JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')) } catch { return null } })
  .filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)))

function push(note) {
  out({
    method: 'notifications/claude/channel',
    params: { content: note.text, meta: { note_id: note.id, at: note.at } },
  })
}

// Suggestions go to "<topic>-s", sealed with the pairing key, so the watch can poll them.
async function sendSuggestion(text, noteId) {
  const cfg = readConfig()
  if (!cfg) return false
  try {
    const body = seal({ s: text, note: noteId, ts: new Date().toISOString() }, Buffer.from(cfg.key, 'base64'))
    return (await fetch(`${cfg.topicURL}-s`, { method: 'POST', body, signal: AbortSignal.timeout(20_000) })).ok
  } catch { return false }
}

async function callTool(name, args = {}) {
  if (name === 'watch_inbox') {
    const pending = allNotes().filter(n => n.status !== 'done')
    return pending.length
      ? pending.map(n => `note_id=${n.id} at=${n.at}\n${n.text}`).join('\n\n---\n\n')
      : 'No pending watch notes.'
  }
  if (name === 'watch_note_done') {
    const f = noteFile(String(args.note_id || ''))
    let n
    try { n = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { throw new Error(`No watch note with id ${args.note_id}`) }
    Object.assign(n, { status: 'done', summary: args.summary, doneAt: new Date().toISOString() })
    const suggestion = typeof args.suggestion === 'string' ? args.suggestion.trim().slice(0, 200) : ''
    if (suggestion) n.suggestion = suggestion
    writeAtomic(f, JSON.stringify(n, null, 2))
    if (!suggestion) return `Marked ${n.id} done.`
    return await sendSuggestion(suggestion, n.id)
      ? `Marked ${n.id} done. Suggestion sent to the watch.`
      : `Marked ${n.id} done. The suggestion couldn't be sent to the watch (relay unreachable).`
  }
  throw new Error(`unknown tool: ${name}`)
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return out({ id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      serverInfo: { name: 'watch-notes', version: '1.3.0' },
      instructions: INSTRUCTIONS,
    } })
  }
  if (method === 'notifications/initialized') {
    ready = true
    // Hand this session anything that arrived while no session was listening.
    sweep()
    return
  }
  if (id === undefined) return // other notifications
  if (method === 'ping') return out({ id, result: {} })
  if (method === 'tools/list') return out({ id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    return callTool(params.name, params.arguments).then(
      text => out({ id, result: { content: [{ type: 'text', text }] } }),
      e => out({ id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } }))
  }
  out({ id, error: { code: -32601, message: `Method not found: ${method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) try { handle(JSON.parse(line)) } catch (e) { log('bad message', e.message) }
  }
})
process.stdin.on('end', () => process.exit(0))

// ---------- notes ----------
// Several Claude Code sessions may run this server at once. Each note file is created
// exactly once (O_EXCL), and a separate <id>.claim marker, also O_EXCL and never moved,
// decides which session gets it. Updates are write-then-rename so readers never see half a file.
const writeAtomic = (f, data) => {
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, f)
}

// Claim markers are generations: <id>.claim, then <id>.claim.1, .2… when a note is rescued.
// Each is created with O_EXCL, so exactly one session wins each generation.
const claimFile = (id, gen) => noteFile(id).replace(/\.json$/, gen ? `.claim.${gen}` : '.claim')

function currentClaim(id) {
  let gen = 0
  while (fs.existsSync(claimFile(id, gen + 1))) gen++
  try {
    const f = claimFile(id, gen)
    const [pid, kind] = fs.readFileSync(f, 'utf8').trim().split(' ')
    return { gen, pid: Number(pid), channel: kind === 'channel', age: Date.now() - fs.statSync(f).mtimeMs }
  } catch { return null }
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const LEGACY_GRACE_MS = 2 * 60_000

// Safety net, run by listening sessions at startup and every 30s. Pushes notes nobody has taken,
// and takes back notes held by a session that wasn't listening (an older version of this plugin
// claimed notes in every session; those claims aren't marked "channel") once it has exited or
// had them for 2 minutes. Notes a listening session took aren't re-sent: it may have done the work.
// Their pending ones stay in watch_inbox.
function sweep() {
  if (!CHANNEL || !ready) return
  for (const n of allNotes()) {
    if (n.status === 'done') continue
    const c = currentClaim(n.id)
    if (!c) claimAndPush(n)
    else if (!c.channel && (!alive(c.pid) || c.age > LEGACY_GRACE_MS)) {
      log('rescuing', n.id, 'from session', c.pid)
      claimAndPush(n, c.gen + 1)
    }
  }
}
setInterval(sweep, Number(process.env.CLAUDE_WATCH_NOTES_SWEEP_MS) || 30_000)

function claimAndPush(n, gen = 0) {
  try { fs.writeFileSync(claimFile(n.id, gen), `${process.pid} channel`, { flag: 'wx' }) } catch { return }
  n = { ...n, status: 'sent' }
  writeAtomic(noteFile(n.id), JSON.stringify(n, null, 2))
  push(n)
}

async function receive(ev, key) {
  if (ev.event !== 'message') return
  let body = ev.message
  // ntfy turns bodies of 4 KB or more into attachments (kept ~3h on ntfy.sh).
  if (ev.attachment?.url && ev.attachment.size <= 64 * 1024) {
    try { body = await (await fetch(ev.attachment.url, { signal: AbortSignal.timeout(30_000) })).text() } catch { return }
  }
  let p
  try { p = open(body, key) } catch { return } // not from our watch: drop silently
  const id = String(p.id || ev.id).replace(/[^\w-]/g, '').slice(0, 64)
  if (!id) return
  const at = typeof p.ts === 'string' && !isNaN(Date.parse(p.ts)) ? p.ts : new Date(ev.time * 1000).toISOString()
  const note = { id, text: String(p.t ?? '').slice(0, 20000), at, status: 'new' }
  // Created once: a retried or concurrently received copy of the same note fails here.
  // If another session saved it first, it may be one that isn't listening: still try to claim it.
  try { fs.writeFileSync(noteFile(id), JSON.stringify(note, null, 2), { flag: 'wx' }); log('note', id) } catch {}
  if (ready && CHANNEL) claimAndPush(note)
}

// ---------- ntfy subscription (auto-reconnect, reloads when re-paired) ----------
let current
fs.watchFile(CONFIG, { interval: 2000 }, () => current?.abort())

async function subscribe() {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 60000)) {
    const cfg = readConfig()
    if (!cfg) {
      log('not paired yet: run `watch-notes pair`')
      await new Promise(r => setTimeout(r, 5000))
      continue
    }
    const key = Buffer.from(cfg.key, 'base64')
    // Cursor is "<topic> <last message id>" so a new pairing starts fresh.
    let since = '12h'
    try {
      const [topic, id] = fs.readFileSync(CURSOR, 'utf8').trim().split(' ')
      if (topic === cfg.topicURL && id) since = id
    } catch {}
    current = new AbortController()
    try {
      for await (const ev of events(`${cfg.topicURL}/json?since=${encodeURIComponent(since)}`, current.signal)) {
        delay = 1000
        await receive(ev, key)
        if (ev.event === 'message') fs.writeFileSync(CURSOR, `${cfg.topicURL} ${ev.id}`)
      }
    } catch (e) {
      if (current.signal.aborted) { log('pairing changed, reconnecting'); delay = 500; continue }
      if (e.message === 'connection idle') delay = 500
      log('subscription:', e.message)
    }
    await new Promise(r => setTimeout(r, delay))
  }
}
subscribe()
