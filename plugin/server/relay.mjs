// Shared by the MCP server and the `handoff` command: relay address, local config,
// the sealing format, and ntfy's streaming JSON subscription.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RELAY = process.env.CLAUDE_WATCH_NOTES_RELAY || 'https://ntfy.sh' // must match Relay.base in the watch app
export const DIR = process.env.CLAUDE_WATCH_NOTES_DIR || path.join(os.homedir(), '.claude-watch-notes')
export const CONFIG = path.join(DIR, 'config.json')
export const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return null } }

// AES-256-GCM in CryptoKit's "combined" layout: nonce(12) | ciphertext | tag(16), base64.
export function open(b64, key) {
  const b = Buffer.from(b64, 'base64')
  if (b.length < 29) throw new Error('short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8'))
}
export function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}

// Yields ntfy events from a streaming JSON subscription.
// If nothing (not even a keepalive) arrives for `idleMs`, the connection is treated as dead.
export async function* events(url, signal, idleMs = Number(process.env.CLAUDE_WATCH_NOTES_IDLE_MS) || 120_000) {
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

// ---------- notes on disk ----------
// Several processes (each Claude Code session's server, and `handoff host`) share this folder.
// Each note file is created exactly once (O_EXCL), and claim markers, also O_EXCL and never moved,
// decide which process handles it. Updates are write-then-rename so readers never see half a file.
export const NOTES = path.join(DIR, 'notes')
export const noteFile = id => path.join(NOTES, `${id.replace(/[^\w-]/g, '')}.json`)

export const writeAtomic = (f, data) => {
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, f)
}

// Claim markers are generations: <id>.claim, then <id>.claim.1, .2… when a note is rescued.
// Each is created with O_EXCL, so exactly one process wins each generation.
const claimFile = (id, gen) => noteFile(id).replace(/\.json$/, gen ? `.claim.${gen}` : '.claim')

export function tryClaim(id, gen = 0) {
  try { fs.writeFileSync(claimFile(id, gen), `${process.pid} channel`, { flag: 'wx' }); return true } catch { return false }
}

export function currentClaim(id) {
  let gen = 0
  while (fs.existsSync(claimFile(id, gen + 1))) gen++
  try {
    const f = claimFile(id, gen)
    const [pid, kind] = fs.readFileSync(f, 'utf8').trim().split(' ')
    return { gen, pid: Number(pid), channel: kind === 'channel', age: Date.now() - fs.statSync(f).mtimeMs }
  } catch { return null }
}

export const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// Decrypts a note event from the watch and saves it (once). Returns {note, created}, or null if
// it isn't a note from our watch.
export async function saveNote(ev, key) {
  if (ev.event !== 'message') return null
  let body = ev.message
  // ntfy turns bodies of 4 KB or more into attachments (kept ~3h on ntfy.sh).
  if (ev.attachment?.url && ev.attachment.size <= 64 * 1024) {
    try { body = await (await fetch(ev.attachment.url, { signal: AbortSignal.timeout(30_000) })).text() } catch { return null }
  }
  let p
  try { p = open(body, key) } catch { return null } // not from our watch: drop silently
  const id = String(p.id || ev.id).replace(/[^\w-]/g, '').slice(0, 64)
  if (!id) return null
  const at = typeof p.ts === 'string' && !isNaN(Date.parse(p.ts)) ? p.ts : new Date(ev.time * 1000).toISOString()
  const note = { id, text: String(p.t ?? '').slice(0, 20000), at, status: 'new' }
  if (typeof p.to === 'string' && p.to) note.to = p.to.slice(0, 40)
  fs.mkdirSync(NOTES, { recursive: true, mode: 0o700 })
  // Created once: a retried or concurrently received copy of the same note fails here.
  try { fs.writeFileSync(noteFile(id), JSON.stringify(note, null, 2), { flag: 'wx' }); return { note, created: true } } catch {}
  try { return { note: JSON.parse(fs.readFileSync(noteFile(id), 'utf8')), created: false } } catch { return { note, created: false } }
}
