# Watch Notes for Claude Code

Jot ideas on your Apple Watch. Claude Code works on them while you're away. **The watch never shows Claude's response**, so there's nothing to get pulled into. It's a scratchpad that hands off and goes quiet.

```
Watch (dictate/scribble) ──AES-GCM──▶ ntfy topic ──▶ watch-notes plugin ──channel──▶ Claude Code session
```

- **Watch app**: one SwiftUI file, watch-only (no iPhone app), no assets or dependencies. It builds for watchOS 26 / Apple Watch SE 3 with `-Osize`, whole-module optimization, and dead-code stripping. Notes queue offline and retry when the app comes back to the foreground.
- **Plugin** (`plugin/`): a Claude Code plugin around one Node file with zero dependencies. It decrypts notes on your Mac and drops anything that doesn't decrypt with your key (prompt-injection gate), then pushes each note into the session as a [channel](https://code.claude.com/docs/en/channels-reference) event.
- **Privacy**: notes are end-to-end encrypted on the watch with a per-device key (stored in the Keychain). The relay only sees ciphertext on a random topic.

## Setup

**1. Install the plugin** (in Claude Code):

```
/plugin marketplace add maxvbuda/claude-watch-notes-mcp
/plugin install watch-notes@watch-notes
```

**2. Get the `watch-notes` command** (in your terminal): `npm install -g github:maxvbuda/claude-watch-notes-mcp`, or `npm link` from a clone.

**3. Install the watch app**: from the App Store, or build it yourself: `cd watch && xcodegen generate && open ClaudeNotes.xcodeproj`, pick your team, then Run.

**4. Pair (once):** run `watch-notes pair`, or `/watch-notes:pair` inside Claude Code. It shows a code like `K7QX-M2PA`; type it into the app on the watch. The watch generates its own topic and key, sends them sealed with a key derived from the code, and waits for the Mac's acknowledgement. Nothing secret is built into the app, so one build works for anyone. Running Claude Code sessions pick up a new pairing automatically. Tap **Unpair** at the bottom of the list to pair again.

## Use

Before you leave, start a session in the project you want Claude to work on. There are two ways.

**Instant (channel mode):**

```sh
watch-notes start             # add --continue to pick up your last conversation
```

Ideas arrive in the session within seconds. `watch-notes start` runs `claude --permission-mode auto` with this plugin's channel turned on, and keeps your Mac awake while the session runs. Until Watch Notes is on Anthropic's approved channel list, Claude Code shows a warning about development channels first: choose **I am using this for local development**.

**Every few minutes (no warning):** in a normal `claude --permission-mode auto` session, run

```
/loop 5m /watch-notes:inbox
```

`--permission-mode auto` lets Claude work without you there to approve each step: a safety classifier reviews every action instead. If it blocks 3 actions in a row, Claude Code goes back to asking in the terminal, so the server tells Claude to skip blocked steps and list them in its summary instead of retrying.

On the watch, tap **Jot an idea…** and add as many lines as you like. Swipe a line to delete it, then tap the orange send button in the corner. A ✓ means the note was delivered.

When you get home, the work is done. Claude calls `watch_note_done` with a summary for each note; the summaries are in `~/.claude-watch-notes/notes/`. Notes that arrive while no session is running are handed to the next session that starts, exactly once even with several sessions open.

## Notes

- ntfy.sh keeps messages for about 12 hours. The server saves them to disk as soon as they arrive, so this only matters if no Claude session is running for that whole time. To self-host ntfy, change `RELAY` in `plugin/server/watch-notes.mjs` and `Relay.base` in `App.swift`.
- ntfy turns messages of 4 KB or more into file attachments, which ntfy.sh keeps for only about 3 hours. The server handles those, but a very long note (roughly 2,900+ characters) needs a session running within that window.

## Tests

```sh
node --test test/server.test.mjs     # server: 39 tests against a mock relay (protocol, crypto, dedupe,
                                     #   multi-session races, reconnects, stalls, re-pairing, pair command)
node test/watch-e2e.mjs              # watch app in the SE 3 simulator + real pair/MCP server, via mock relay
node test/watch-e2e.mjs --real-relay # same UI flow through the public ntfy.sh
```

The watch end-to-end run unpairs the simulator. Afterwards, run `pair` again.

See [PRIVACY.md](PRIVACY.md) for exactly what data goes where, and [docs/official-listing.md](docs/official-listing.md) for the plan to get Watch Notes on Anthropic's approved channel list.

