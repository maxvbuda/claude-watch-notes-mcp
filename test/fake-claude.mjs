#!/usr/bin/env node
// Stands in for `claude -p` in host tests: records how it was called, prints stream-json like the
// real thing, and fails on request (a prompt containing "FAIL").
import fs from 'node:fs'

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt, name: process.env.CLAUDE_WATCH_NOTES_NAME }) + '\n')

const session = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1]
const say = m => process.stdout.write(JSON.stringify({ session_id: session, ...m }) + '\n')
say({ type: 'system', subtype: 'init' })
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
if (prompt.includes('FAIL')) {
  say({ type: 'result', is_error: true, result: 'something broke' })
  process.exit(1)
}
say({ type: 'result', is_error: false, result: `Did: ${prompt.split('\n')[0]}` })
