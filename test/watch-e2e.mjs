// Full-stack test: watchOS simulator app  <->  mock relay  <->  real `pair` + MCP server.
//   node test/watch-e2e.mjs [simulator-udid] [--real-relay]
// --real-relay runs the UI phase through the public ntfy.sh instead of the mock.
// Phase 1 runs the XCTest unit suite in the simulator, phase 2 the UI test. After each phase,
// checks that the MCP server pushed exactly the expected notes into the "session", once each.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMock } from './mock-ntfy.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SERVER = path.join(ROOT, 'plugin/server/watch-notes.mjs')
const args = process.argv.slice(2)
const REAL = args.includes('--real-relay')
const SIM = args.find(a => !a.startsWith('--')) || 'EB3AEAD7-06BA-439B-B2F0-B6F22A2F825F' // Apple Watch SE 3 (40mm)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const code = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('')

const mock = await startMock({ port: 8799 })
const relay = REAL ? 'https://ntfy.sh' : mock.url
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-e2e-'))
const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: relay, CLAUDE_WATCH_NOTES_NO_SIM: '1', CLAUDE_WATCH_NOTES_CHANNEL: '1', CLAUDE_WATCH_NOTES_NAME: 'e2e-chat' }

// The MCP server, as Claude Code would run it.
const server = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] })
const pushes = []
let buf = ''
server.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.method === 'notifications/claude/channel') pushes.push(m.params.content)
  }
})
// `watch-notes host` in dry-run mode: records which chats the watch asks it to start.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-e2e-root-')))
fs.mkdirSync(path.join(root, 'e2e-project/sub'), { recursive: true })
const host = spawn(process.execPath, [path.join(ROOT, 'cli/watch-notes.mjs'), 'host', root], { env: { ...env, CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1' } })
let hostOut = ''
host.stdout.on('data', d => { hostOut += d })

server.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n')

function startPair(c) {
  const p = spawn(process.execPath, [SERVER, 'pair'], { env: { ...env, CLAUDE_WATCH_NOTES_PAIR_CODE: c } })
  let out = ''
  p.stdout.on('data', d => { out += d })
  return { exit: new Promise(r => p.on('exit', code => r({ code, out }))), kill: () => p.kill() }
}

// Must not block: the mock relay and MCP server live in this process's event loop.
async function xctest(only, c) {
  const p = spawn('xcodebuild', [
    'test', '-project', path.join(ROOT, 'watch/ClaudeNotes.xcodeproj'), '-scheme', 'ClaudeNotes',
    '-destination', `id=${SIM}`, '-derivedDataPath', path.join(ROOT, 'build/dd-test'),
    `-only-testing:${only}`, 'CODE_SIGN_IDENTITY=-',
  ], { env: { ...process.env, TEST_RUNNER_RELAY: relay, TEST_RUNNER_PAIR_CODE: c } })
  let log = ''
  p.stdout.on('data', d => { log += d }); p.stderr.on('data', d => { log += d })
  const status = await new Promise(r => p.on('exit', r))
  fs.writeFileSync(path.join(ROOT, `build/${only}.log`), log)
  const cases = [...log.matchAll(/Test [Cc]ase '-\[\S+ (\w+)\]' (passed|failed) \(([\d.]+) seconds\)/g)]
  for (const [, name, result, secs] of cases) console.log(`  ${result === 'passed' ? '✔' : '✖'} ${name} (${secs}s)`)
  for (const m of log.matchAll(/error: (.+)/g)) console.log(`    ${m[1].slice(0, 300)}`)
  return { ok: status === 0 && /\*\* TEST SUCCEEDED \*\*/.test(log), cases: cases.length }
}

async function settle() { // let in-flight deliveries land
  let n = -1
  while (n !== pushes.length) { n = pushes.length; await sleep(1500) }
}
const once = (text) => assert.equal(pushes.filter(p => p === text).length, 1, `expected exactly one push of ${JSON.stringify(text.slice(0, 60))}, got ${pushes.filter(p => p === text).length}`)

let failed = false
try {
  if (!REAL) {
  console.log('Phase 1: unit tests in the watch simulator')
  const c1 = code(); const pair1 = startPair(c1)
  const unit = await xctest('ClaudeNotesTests', c1)
  const p1 = await Promise.race([pair1.exit, sleep(1000).then(() => ({ code: 'still running' }))])
  pair1.kill()
  await settle()
  assert.ok(unit.ok, 'XCTest unit suite failed (see build/ClaudeNotesTests.log)')
  assert.equal(p1.code, 0, 'pair did not complete')
  for (let i = 1; i <= 3; i++) once(`e2e offline ${i}`)
  const offline = pushes.filter(p => p.startsWith('e2e offline'))
  assert.deepEqual(offline, ['e2e offline 1', 'e2e offline 2', 'e2e offline 3'], 'queued notes out of order')
  once('e2e retried after relay errors')
  once('e2e unicode café ☕️ "quotes" 日本語 🚀\nsecond line')
  once('e2e long ' + 'lorem ipsum '.repeat(450))
  for (let i = 1; i <= 15; i++) once(`e2e trim ${i}`)
  once('e2e accepted suggestion')
  once('e2e history 1')
  once('e2e to chat')
  const launches = [...hostOut.matchAll(/^LAUNCH (.*)$/gm)].map(m => JSON.parse(m[1]))
  assert.deepEqual(launches.map(l => [l.dir, l.name]), [
    [path.join(root, 'e2e-project'), 'e2e-project'],
    [path.join(root, 'e2e-project/sub/from-watch'), 'from-watch'],
  ], 'host did not start the requested chats')
  assert.ok(fs.statSync(path.join(root, 'e2e-project/sub/from-watch')).isDirectory())
  assert.equal(pushes.filter(p => p === 'e2e to elsewhere').length, 0, 'a note for another chat was delivered here')
  assert.equal(pushes.filter(p => p.startsWith('unsent')).length, 0)
  console.log(`  ✔ MCP server received all ${pushes.length} notes exactly once, in order\n`)
  }

  console.log(`Phase 2: UI test in the watch simulator (relay: ${relay})`)
  const before = pushes.length
  const c2 = code(); const pair2 = startPair(c2)
  const ui = await xctest('ClaudeNotesUITests', c2)
  pair2.kill()
  await settle()
  assert.ok(ui.ok, 'UI test failed (see build/ClaudeNotesUITests.log)')
  once('e2e ui line 1\ne2e ui line 2')
  assert.equal(pushes.length, before + 1)
  console.log('  ✔ note sent from the watch UI reached the MCP server exactly once')
} catch (e) {
  failed = true
  console.error(`\n✖ ${e.message}`)
  console.error(`  pushes: ${JSON.stringify(pushes.map(p => p.slice(0, 40)))}`)
} finally {
  server.kill()
  host.kill()
  await mock.close()
}
process.exit(failed ? 1 : 0)
