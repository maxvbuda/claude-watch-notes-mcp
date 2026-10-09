#!/usr/bin/env node
// `handoff`: terminal command for Handoff. Lives outside the plugin so the plugin itself
// never launches programs.
//
//   handoff pair              pair your watch (shows a code to type on it)
//   handoff start [--name N] [args...]   start Claude Code listening for ideas
//   handoff host [folder]     let the watch start chats in folder's projects (run headless here)

import { spawn, execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG, DIR, NOTES, events, noteFile, open, readConfig, saveNote, seal, tryClaim, writeAtomic } from '../plugin/server/relay.mjs'

const SERVER = fileURLToPath(new URL('../plugin/server/handoff.mjs', import.meta.url))

// Custom channels need the development flag until the plugin is on Anthropic's approved list;
// then this becomes ['--channels', 'plugin:handoff@claude-plugins-official'].
const CHANNEL_ARGS = ['--dangerously-load-development-channels', 'plugin:handoff@handoff']

const [cmd, ...rest] = process.argv.slice(2)

function run(file, args, opts) {
  const child = spawn(file, args, opts)
  child.on('error', e => {
    console.error(e.code === 'ENOENT' ? `\`${file}\` not found.` : e.message)
    process.exit(1)
  })
  child.on('exit', code => process.exit(code ?? 0))
  return child
}

if (cmd === 'start') {
  // --name sets the chat's name on the watch (default: this folder's name). Everything else goes to claude.
  let name = path.basename(process.cwd())
  const i = rest.findIndex(a => a === '--name' || a.startsWith('--name='))
  if (i >= 0) {
    const [flag, value] = rest[i].includes('=') ? [1, rest[i].slice(7)] : [2, rest[i + 1]]
    if (!value) { console.error('Usage: handoff start --name <chat name>'); process.exit(1) }
    name = value
    rest.splice(i, flag)
  }
  const claudeArgs = ['--permission-mode', 'auto', ...CHANNEL_ARGS, ...rest]
  console.log(`Starting Claude Code with Handoff as the chat "${name}". Ideas from your watch will show up here.\n` +
    'Claude Code will warn about development channels: choose "I am using this for local development".\n')
  // caffeinate keeps the Mac awake (so Claude can keep working) for as long as the session runs.
  // Tells this session's plugin server that it's listening, so it (not other open sessions) takes the notes.
  const opts = { stdio: 'inherit', env: { ...process.env, CLAUDE_WATCH_NOTES_CHANNEL: '1', CLAUDE_WATCH_NOTES_NAME: name } }
  if (process.platform === 'darwin') run('caffeinate', ['-i', 'claude', ...claudeArgs], opts)
  else run('claude', claudeArgs, opts)
} else if (cmd === 'pair') {
  const child = run(process.execPath, [SERVER, 'pair'], { stdio: ['inherit', 'pipe', 'inherit'] })
  let sent = false
  child.stdout.on('data', d => {
    process.stdout.write(d)
    const code = /Pairing code:\s+([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(String(d))
    if (code && !sent) { sent = true; sendToSimulators(code[1] + code[2]) }
  })
} else if (cmd === 'host') {
  host(path.resolve(rest[0] || process.cwd()))
} else {
  console.log(`Handoff: jot ideas on your Apple Watch; Claude Code does them while you're away.

  handoff pair              Pair your watch (shows a code to type on it)
  handoff start [args...]   Start Claude Code listening for ideas (extra args go to claude,
                            e.g. --continue to keep your last conversation)
    --name <name>           The chat's name on the watch (default: this folder's name)
  handoff host [folder]     Let the watch start new chats: lists the projects in folder
                            (default: this one) on the watch and opens a Terminal window
                            running handoff start in the one you pick
`)
}

// Typing on a simulated watch is painful: hand the code to any booted watch simulator with the app.
function sendToSimulators(code) {
  if (process.platform !== 'darwin') return
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

// ---------- host: new chats from the watch ----------
// Lets the watch start chats in folders under `root` without anyone at the Mac. These chats run
// Claude Code headless (`claude -p`, one run per note, resuming the same session), so no channel
// and no confirmation prompt are involved. The host:
//   - announces its projects and chats on "<topic>-c", sealed, every minute;
//   - answers {ls, id} requests on "<topic>-n" with {ls, id, dirs} on "<topic>-l" (folder browsing);
//   - registers a chat for {path, name, create?} requests, and opens a Terminal window showing its log;
//   - takes notes addressed to its chats from the main topic and runs them, one at a time per chat.
// Paths are relative to `root`; anything that resolves outside it (.., symlinks) is refused.
function host(root) {
  if (!fs.existsSync(root)) { console.error(`No such folder: ${root}`); process.exit(1) }
  root = fs.realpathSync(root)
  // root/rel, if it's an existing folder inside root (or root itself), else null.
  const inside = rel => {
    if (typeof rel !== 'string' || rel.length > 500 || rel.includes('\0')) return null
    try {
      const real = fs.realpathSync(path.resolve(root, rel))
      return (real === root || real.startsWith(root + path.sep)) && fs.statSync(real).isDirectory() ? real : null
    } catch { return null }
  }
  const subfolders = dir => fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => (d.isDirectory() || (d.isSymbolicLink() && inside(path.relative(root, path.join(dir, d.name))))) &&
      !d.name.startsWith('.') && d.name !== 'node_modules')
    .map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 60)
  const hostName = os.hostname().replace(/\.local$/, '')
  const projects = () => subfolders(root)
  const dryRun = !!process.env.CLAUDE_WATCH_NOTES_HOST_DRYRUN // tests: don't open Terminal windows
  const q = v => `'${String(v).replace(/'/g, `'\\''`)}'` // single-quoted for the shell

  // Chats: name -> {dir, session, started, lastUsed}, kept across restarts. Each has a log file.
  const CHATS = path.join(DIR, 'host-chats.json')
  const LOGS = path.join(DIR, 'logs')
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 })
  let chats = {}
  try { chats = JSON.parse(fs.readFileSync(CHATS, 'utf8')) } catch {}
  const saveChats = () => writeAtomic(CHATS, JSON.stringify(chats, null, 2))
  const recentChats = () => Object.keys(chats).filter(n => Date.now() - Date.parse(chats[n].lastUsed) < 3 * 86_400_000)
  const logFile = name => path.join(LOGS,
    `${name.replace(/[^\w.-]+/g, '-').slice(0, 30)}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}.log`)
  const logTo = (name, text) => fs.appendFileSync(logFile(name), text)
  const resumeCommand = c => `cd ${q(c.dir)} && claude --resume ${c.session}`

  const post =(obj, timeout = 20_000, suffix = 'c') => {
    const cfg = readConfig()
    if (!cfg) return Promise.resolve()
    return fetch(`${cfg.topicURL}-${suffix}`, { method: 'POST', body: seal({ ...obj, ts: new Date().toISOString() }, Buffer.from(cfg.key, 'base64')), signal: AbortSignal.timeout(timeout) })
      .catch(() => {})
  }
  const announce = () => post({ host: hostName, root: path.basename(root), projects: projects(), chats: recentChats() })
  setInterval(announce, Number(process.env.CLAUDE_WATCH_NOTES_HEARTBEAT_MS) || 60_000)
  const quit = async () => { await post({ host: hostName, gone: true }, 3000); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)

  console.log(`Handoff host: the watch can start chats in ${projects().length} projects in ${root}.\n` +
    'Chats started from the watch run here, with no confirmation needed. Keep this running; Ctrl+C stops it.\n')
  for (const n of recentChats()) console.log(`  chat "${n}"  (open it: ${resumeCommand(chats[n])})`)
  if (!readConfig()) console.log('Not paired yet: run `handoff pair`.')

  // Relay subscriptions: reconnect with backoff, and restart with the new key when re-paired.
  const subs = new Set()
  fs.watchFile(CONFIG, { interval: 2000 }, () => subs.forEach(c => c.abort()))
  function subscribe(suffix, since, onMessage) {
    ;(async () => {
      for (let delay = 1000; ; delay = Math.min(delay * 2, 60_000)) {
        const cfg = readConfig()
        if (!cfg) { await new Promise(r => setTimeout(r, 5000)); continue }
        const ctrl = new AbortController()
        subs.add(ctrl)
        try {
          for await (const ev of events(`${cfg.topicURL}${suffix}/json?since=${encodeURIComponent(since(cfg))}`, ctrl.signal)) {
            delay = 1000
            if (ev.event === 'message') await onMessage(ev, Buffer.from(cfg.key, 'base64'), cfg)
          }
        } catch (e) {
          if (!ctrl.signal.aborted) console.error(`relay: ${e.message}`)
        }
        subs.delete(ctrl)
        await new Promise(r => setTimeout(r, ctrl.signal.aborted ? 200 : delay))
      }
    })()
  }
  announce()

  // Requests from the watch: only ones made from now on.
  let reqSince = String(Math.floor(Date.now() / 1000))
  subscribe('-n', () => reqSince, (ev, key) => {
    reqSince = ev.id
    let req
    try { req = open(ev.message, key) } catch { return } // not from our watch
    if (!(Date.now() - Date.parse(req.ts) < 10 * 60_000)) return console.log('Skipped an old request.')
    if (req.ls !== undefined) listFolder(req)
    else startChat(req)
  })

  // Notes: the host keeps its own cursor, so notes for its chats arrive with no Claude Code window open.
  const CURSOR = path.join(DIR, 'host-cursor')
  const noteSince = cfg => {
    try { const [t, id] = fs.readFileSync(CURSOR, 'utf8').trim().split(' '); if (t === cfg.topicURL && id) return id } catch {}
    return '12h'
  }
  subscribe('', noteSince, async (ev, key, cfg) => {
    const got = await saveNote(ev, key)
    if (got && chats[got.note.to] && got.note.status === 'new') take(got.note)
    fs.writeFileSync(CURSOR, `${cfg.topicURL} ${ev.id}`)
  })
  // Also pick up notes for our chats that a Claude Code window saved before we saw them.
  const sweep = () => {
    let files = []
    try { files = fs.readdirSync(NOTES).filter(f => f.endsWith('.json')) } catch {}
    for (const f of files) {
      try { const n = JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')); if (n.status === 'new' && chats[n.to]) take(n) } catch {}
    }
  }
  sweep()
  setInterval(sweep, Number(process.env.CLAUDE_WATCH_NOTES_SWEEP_MS) || 30_000)

  function listFolder(req) {
    const dir = inside(req.ls)
    const dirs = dir ? subfolders(dir) : null
    post({ ls: req.ls, id: String(req.id ?? ''), dirs }, 20_000, 'l')
  }

  function startChat(req) {
    let dir = inside(req.path ?? req.project) // `project`: watch builds from before folder browsing
    if (!dir) return console.log('Skipped a request for a folder outside the host folder.')
    if (req.create !== undefined) { // a new folder, made here first
      const folder = String(req.create).trim()
      if (!folder || folder.length > 60 || /[\/\u0000-\u001f\u007f]/.test(folder) || folder.startsWith('.'))
        return console.log('Skipped a request with a bad folder name.')
      dir = path.join(dir, folder)
      try { fs.mkdirSync(dir) } catch (e) { if (e.code !== 'EEXIST') return console.log(`Couldn't make ${dir}: ${e.message}`) }
    }
    const fallback = path.basename(dir)
    const name = String(req.name || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || fallback
    const chat = chats[name] = { dir, session: crypto.randomUUID(), started: false, lastUsed: new Date().toISOString() }
    saveChats()
    announce()
    console.log(`Started chat "${name}" in ${dir}  (open it: ${resumeCommand(chat)})`)
    logTo(name, `Chat "${name}" in ${dir}\nTo open it as a normal Claude Code window: ${resumeCommand(chat)}\nWaiting for notes from your watch…\n`)
    // A Terminal window that shows this chat's log as Claude works. Every value is single-quoted.
    const script = [
      '#!/bin/sh',
      'rm -f "$0"',
      `printf '\\033]0;%s\\007' ${q(`Handoff: ${name}`)}`,
      `exec tail -n +1 -F ${q(logFile(name))}`,
    ].join('\n') + '\n'
    if (dryRun) return console.log(`LAUNCH ${JSON.stringify({ dir, name, session: chat.session, script })}`)
    const file = path.join(os.tmpdir(), `handoff-${crypto.randomUUID()}.command`)
    fs.writeFileSync(file, script, { mode: 0o700 })
    execFile('open', ['-a', 'Terminal', file], e => { if (e) console.error(`Couldn't open Terminal: ${e.message}`) })
  }

  // Running notes: one at a time per chat, each continuing the chat's Claude Code session.
  const queues = new Map()
  function take(n) {
    if (!tryClaim(n.id)) return // another process has it
    writeAtomic(noteFile(n.id), JSON.stringify({ ...n, status: 'sent' }, null, 2))
    queues.set(n.to, (queues.get(n.to) || Promise.resolve()).then(() => runNote(n)).catch(e => console.error(e)))
  }

  async function runNote(n) {
    const chat = chats[n.to]
    const stamp = () => new Date().toLocaleTimeString()
    logTo(n.to, `\n━━ ${stamp()} Note from your watch:\n${n.text}\n\n`)
    console.log(`Chat "${n.to}": working on a note`)
    const prompt = `${n.text}\n\n---\nThis is a note the user jotted on their Apple Watch (note_id=${n.id}). They are away and ` +
      'will not see or answer questions: do it autonomously in this project, making reasonable assumptions. If an action is ' +
      `blocked by the permission system, skip it and mention it. When finished, call watch_note_done with note_id ${n.id}, ` +
      'a short summary, and optionally a suggestion (the next prompt they would likely send).'
    const args = ['-p', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', 'mcp__plugin_handoff_handoff__watch_note_done',
      ...(chat.started ? ['--resume', chat.session] : ['--session-id', chat.session])]
    const env = { ...process.env, CLAUDE_WATCH_NOTES_NAME: n.to }
    delete env.CLAUDE_WATCH_NOTES_CHANNEL // its plugin server must not claim other notes
    let result = '', failed = null, sawSession = false
    await new Promise(resolve => {
      const child = spawn(process.env.CLAUDE_WATCH_NOTES_CLAUDE || 'claude', args, { cwd: chat.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', e => { failed = e.code === 'ENOENT' ? '`claude` not found' : e.message; resolve() })
      child.stdin.end(prompt) // on stdin, so a note starting with "-" can't be read as an option
      let buf = ''
      child.stdout.on('data', d => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          let m
          try { m = JSON.parse(line) } catch { continue }
          if (m.session_id) sawSession = true
          if (m.type === 'assistant') {
            for (const c of m.message?.content ?? []) {
              if (c.type === 'text' && c.text.trim()) logTo(n.to, `${c.text.trim()}\n\n`)
              if (c.type === 'tool_use') logTo(n.to, `  → ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 160)}\n`)
            }
          } else if (m.type === 'result') {
            result = String(m.result ?? '')
            if (m.is_error) failed = result || 'Claude reported an error'
          }
        }
      })
      child.stderr.on('data', d => logTo(n.to, String(d)))
      child.on('close', code => { if (code && !failed) failed = `claude exited with code ${code}`; resolve() })
    })
    if (sawSession) chat.started = true
    chat.lastUsed = new Date().toISOString()
    saveChats()
    // If Claude didn't call watch_note_done, keep its final answer as the summary.
    let saved = n
    try { saved = JSON.parse(fs.readFileSync(noteFile(n.id), 'utf8')) } catch {}
    if (saved.status !== 'done') {
      writeAtomic(noteFile(n.id), JSON.stringify({ ...saved, status: failed ? 'failed' : 'done',
        summary: failed ? `Failed: ${failed}` : result.slice(0, 4000) || 'Finished (no summary).', doneAt: new Date().toISOString() }, null, 2))
    }
    logTo(n.to, failed ? `━━ ${stamp()} Failed: ${failed}\n` : `━━ ${stamp()} Done.\n`)
    console.log(`Chat "${n.to}": ${failed ? `failed (${failed})` : 'done'}`)
  }
}
