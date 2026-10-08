#!/usr/bin/env node
// `watch-notes`: terminal command for Watch Notes. Lives outside the plugin so the plugin itself
// never launches programs.
//
//   watch-notes pair              pair your watch (shows a code to type on it)
//   watch-notes start [args...]   start Claude Code listening for ideas

import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../plugin/server/watch-notes.mjs', import.meta.url))

// Custom channels need the development flag until the plugin is on Anthropic's approved list;
// then this becomes ['--channels', 'plugin:watch-notes@claude-plugins-official'].
const CHANNEL_ARGS = ['--dangerously-load-development-channels', 'plugin:watch-notes@watch-notes']

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
  const claudeArgs = ['--permission-mode', 'auto', ...CHANNEL_ARGS, ...rest]
  console.log('Starting Claude Code with Watch Notes. Ideas from your watch will show up here.\n' +
    'Claude Code will warn about development channels: choose "I am using this for local development".\n')
  // caffeinate keeps the Mac awake (so Claude can keep working) for as long as the session runs.
  // Tells this session's plugin server that it's listening, so it (not other open sessions) takes the notes.
  const opts = { stdio: 'inherit', env: { ...process.env, CLAUDE_WATCH_NOTES_CHANNEL: '1' } }
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
} else {
  console.log(`Watch Notes: jot ideas on your Apple Watch; Claude Code does them while you're away.

  watch-notes pair              Pair your watch (shows a code to type on it)
  watch-notes start [args...]   Start Claude Code listening for ideas (extra args go to claude,
                                e.g. --continue to keep your last conversation)
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
