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
