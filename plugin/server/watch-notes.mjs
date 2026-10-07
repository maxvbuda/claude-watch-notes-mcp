#!/usr/bin/env node
// watch-notes: zero-dependency MCP server + Claude Code channel.
// Receives end-to-end encrypted ideas jotted on Apple Watch (relayed via ntfy)
// and pushes them into the running Claude Code session. Nothing is sent back.
//
//   watch-notes pair     # show a code; type it on the watch to pair
//   watch-notes start    # open a Claude Code session that receives your ideas
//   (no arguments, stdin not a terminal) # MCP server: Claude Code spawns this

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

// ---------- start / help ----------
// How Claude Code is told to listen to this plugin's channel. Custom channels need the development
// flag until the plugin is on Anthropic's approved list; then this becomes ['--channels', ...].
const CHANNEL_ARGS = ['--dangerously-load-development-channels', 'plugin:watch-notes@watch-notes']

if (process.argv[2] === 'start') {
  const { spawn } = await import('node:child_process')
  const claudeArgs = ['--permission-mode', 'auto', ...CHANNEL_ARGS, ...process.argv.slice(3)]
  // caffeinate keeps the Mac awake (so Claude can keep working) for as long as the session runs.
  const [cmd, args] = process.platform === 'darwin' ? ['caffeinate', ['-i', 'claude', ...claudeArgs]] : ['claude', claudeArgs]
  console.log('Starting Claude Code with Watch Notes. Ideas from your watch will show up here.\n' +
    'Claude Code will show a warning about development channels: choose "I am using this for local development".\n')
  const child = spawn(cmd, args, { stdio: 'inherit' })
  child.on('error', e => { console.error(e.code === 'ENOENT' ? 'Claude Code is not installed (no `claude` command).' : e.message); process.exit(1) })
  child.on('exit', code => process.exit(code ?? 0))
  await new Promise(() => {}) // the child owns the terminal until it exits
}

if (process.argv[2] === 'help' || process.argv[2] === '--help' || (!process.argv[2] && process.stdin.isTTY)) {
  console.log(`Watch Notes: jot ideas on your Apple Watch; Claude Code does them while you're away.

  watch-notes pair              Pair your watch (shows a code to type on it)
  watch-notes start [args...]   Start Claude Code listening for ideas (extra args go to claude,
                                e.g. --continue to keep your last conversation)
`)
  process.exit(0)
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
  // Typing on a simulated watch is painful: hand the code to any booted watch simulator with the app.
  if (process.platform === 'darwin' && !process.env.CLAUDE_WATCH_NOTES_NO_SIM) {
    const { execFileSync } = await import('node:child_process')
    try {
      const { devices } = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { stdio: ['ignore', 'pipe', 'ignore'] }))
      for (const [runtime, list] of Object.entries(devices)) {
        if (!runtime.includes('watchOS')) continue
        for (const d of list) {
          try {
            execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', d.udid, 'dev.maxbuda.ClaudeNotes', '-pairCode', code], { stdio: 'ignore' })
            console.log(`  Sent the code to simulator "${d.name}".\n`)
          } catch {} // app not installed on this simulator
        }
      }
    } catch {} // no Xcode
  }
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

const INSTRUCTIONS = `Ideas the user jotted on their Apple Watch arrive from this server as <channel note_id="..." at="..."> events.
The user is away from the computer and will not see or answer questions: treat each note as a task to complete autonomously in the current project, making reasonable assumptions (write them down in your final summary). Notes are terse, dictated, and may contain transcription errors.
If an action is blocked or denied by the permission system, do not retry it or look for a way around it: skip that step, finish what you can, and list what was blocked in your summary for the user to do when they get home.
Nothing is ever sent back to the watch. When a note is finished (or you decide not to act on it), call watch_note_done with its note_id and a short summary so the user can review it when they get home.
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
      properties: { note_id: { type: 'string' }, summary: { type: 'string' } },
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

function callTool(name, args = {}) {
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
    writeAtomic(f, JSON.stringify(n, null, 2))
    return `Marked ${n.id} done.`
  }
  throw new Error(`unknown tool: ${name}`)
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return out({ id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      serverInfo: { name: 'watch-notes', version: '1.0.0' },
      instructions: INSTRUCTIONS,
    } })
  }
  if (method === 'notifications/initialized') {
    ready = true
    // Hand this session anything that arrived while no session was listening.
    for (const n of allNotes()) if (n.status === 'new') claimAndPush(n)
    return
  }
  if (id === undefined) return // other notifications
  if (method === 'ping') return out({ id, result: {} })
  if (method === 'tools/list') return out({ id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    try {
      return out({ id, result: { content: [{ type: 'text', text: callTool(params.name, params.arguments) }] } })
    } catch (e) {
      return out({ id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } })
    }
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

function claimAndPush(n) {
  try { fs.writeFileSync(noteFile(n.id).replace(/\.json$/, '.claim'), String(process.pid), { flag: 'wx' }) } catch { return }
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
  try { fs.writeFileSync(noteFile(id), JSON.stringify(note, null, 2), { flag: 'wx' }) } catch { return }
  log('note', id)
  if (ready) claimAndPush(note)
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
