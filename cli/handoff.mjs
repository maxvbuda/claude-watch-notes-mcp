#!/usr/bin/env node
// `handoff`: terminal command for Handoff. Lives outside the plugin so the plugin itself
// never launches programs.
//
//   handoff pair              pair your watch (shows a code to type on it)
//   handoff start [--name N] [args...]   start Claude Code listening for ideas
//   handoff host [folder]     let the watch open new chats in folder's projects

import { spawn, execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG, events, open, readConfig, seal } from '../plugin/server/relay.mjs'

const SERVER = fileURLToPath(new URL('../plugin/server/handoff.mjs', import.meta.url))
const CLI = fileURLToPath(import.meta.url)

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
// Announces the projects (subfolders of `root`) on "<topic>-c", sealed, every minute, and listens on
// "<topic>-n" for sealed requests:
//   {ls: <path>, id, ts}                      → replies {ls, id, dirs} on "<topic>-l" (folder browsing)
//   {path, name, create?, ts}                 → opens a Terminal window running
//                                               `handoff start --name <name>` in root/path[/create]
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

  const post = (obj, timeout = 20_000, suffix = 'c') => {
    const cfg = readConfig()
    if (!cfg) return Promise.resolve()
    return fetch(`${cfg.topicURL}-${suffix}`, { method: 'POST', body: seal({ ...obj, ts: new Date().toISOString() }, Buffer.from(cfg.key, 'base64')), signal: AbortSignal.timeout(timeout) })
      .catch(() => {})
  }
  const announce = () => post({ host: hostName, root: path.basename(root), projects: projects() })
  setInterval(announce, Number(process.env.CLAUDE_WATCH_NOTES_HEARTBEAT_MS) || 60_000)
  const quit = async () => { await post({ host: hostName, gone: true }, 3000); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)

  console.log(`Handoff host: the watch can start new chats in ${projects().length} projects in ${root}.\n` +
    'Keep this running. Press Ctrl+C to stop.\n')

  let current
  fs.watchFile(CONFIG, { interval: 2000 }, () => current?.abort()) // re-paired: reconnect with the new key
  ;(async () => {
    let since = String(Math.floor(Date.now() / 1000)) // only requests made from now on
    for (let delay = 1000; ; delay = Math.min(delay * 2, 60_000)) {
      const cfg = readConfig()
      if (!cfg) { console.log('Not paired yet: run `handoff pair`.'); await new Promise(r => setTimeout(r, 5000)); continue }
      announce()
      current = new AbortController()
      try {
        for await (const ev of events(`${cfg.topicURL}-n/json?since=${since}`, current.signal)) {
          delay = 1000
          if (ev.event !== 'message') continue
          since = ev.id
          let req
          try { req = open(ev.message, Buffer.from(cfg.key, 'base64')) } catch { continue } // not from our watch
          if (!(Date.now() - Date.parse(req.ts) < 10 * 60_000)) { console.log('Skipped an old request.'); continue }
          if (req.ls !== undefined) listFolder(req)
          else startChat(req)
        }
      } catch (e) {
        if (!current.signal.aborted) console.error(`relay: ${e.message}`)
      }
      await new Promise(r => setTimeout(r, current.signal.aborted ? 200 : delay))
    }
  })()

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
    console.log(`Starting chat "${name}" in ${dir}`)
    // A .command file opens in a new Terminal window. Every value is single-quoted for the shell.
    const q = v => `'${String(v).replace(/'/g, `'\\''`)}'`
    const script = [
      '#!/bin/sh',
      'rm -f "$0"',
      `export PATH=${q(process.env.PATH)}`,
      `cd ${q(dir)} || exit 1`,
      `exec ${q(process.execPath)} ${q(CLI)} start --name ${q(name)}`,
    ].join('\n') + '\n'
    if (process.env.CLAUDE_WATCH_NOTES_HOST_DRYRUN) return console.log(`LAUNCH ${JSON.stringify({ dir, name, script })}`)
    const file = path.join(os.tmpdir(), `handoff-${crypto.randomUUID()}.command`)
    fs.writeFileSync(file, script, { mode: 0o700 })
    execFile('open', ['-a', 'Terminal', file], e => { if (e) console.error(`Couldn't open Terminal: ${e.message}`) })
  }
}
