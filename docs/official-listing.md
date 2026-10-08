# Getting Watch Notes on Claude Code's approved channel list

## How approval works today

- During the channels research preview, `--channels` only accepts plugins on Anthropic's allowlist: the plugins in [`claude-plugins-official`](https://github.com/anthropics/claude-plugins-official). Everything else needs `--dangerously-load-development-channels`.
- `claude-plugins-official` **doesn't take public submissions**. The docs say: "If you work with an Anthropic partner contact, ask them about an official-marketplace listing."
- The public plugin directory (submitted at [claude.ai/directory/manage](https://claude.com/docs/plugins/submit)) feeds the community marketplace, which is **not** on the channel allowlist.

So there's no form to fill in. The route is to make Watch Notes easy to say yes to, get it in front of Anthropic, and ask.

## Plan

1. **Publish the repo** on GitHub as `maxvbuda/claude-watch-notes-mcp`. The plugin manifest, privacy policy, and install commands already point there.
2. **Submit to the plugin directory** at claude.ai/directory/manage. This needs a paid Claude plan. It works in `/loop` mode with no warnings, and it gets the plugin an Anthropic quality and security review, which is a useful track record. Draft text is below.
3. **Open a feature request** on [anthropics/claude-code](https://github.com/anthropics/claude-code/issues) asking for a path for community channels to be allowlisted, with Watch Notes as the concrete example. Draft is below.
4. **Ship the watch app** on the App Store, so there are real users to point to.
5. **If you ever get an Anthropic contact**, through the feature request, an event, or anywhere else, send the short note below.

## Readiness: how it compares to the official channel plugins

| What reviewers look for | Watch Notes |
|---|---|
| Sender gating (docs: "An ungated channel is a prompt injection vector") | Only messages sealed with the paired watch's AES-256-GCM key are accepted. Everything else is dropped silently, and tests cover plaintext, wrong-key, truncated, junk, and replayed messages |
| Pairing flow | One-time 8-character code (HKDF → pairing key and topic). Wrong codes fail closed |
| Permission relay | Not declared, on purpose. The watch can't approve tool use |
| Reply tool | None. Claude's responses never reach the watch; only an optional one-line suggested next prompt does, encrypted with the same key |
| Dependencies | Zero. One Node file, with no `node_modules` and no Bun required |
| Manifest | Declares `channels`, and passes `claude plugin validate --strict` |
| Tests | 40 server tests (protocol, crypto, dedupe, multi-session races, reconnects, stalls, re-pairing) plus watchOS simulator unit, UI, and end-to-end tests |
| Privacy | [PRIVACY.md](../PRIVACY.md). No developer servers or analytics. The relay only sees ciphertext |

## Draft: plugin directory submission

**Name:** Watch Notes

**Short description:** Jot ideas on your Apple Watch; Claude Code works on them while you're away.

**Long description:**
Watch Notes turns your Apple Watch into a distraction-free inbox for Claude Code. Dictate or scribble an idea on your wrist and tap send. Claude Code on your Mac picks it up and gets to work. The watch never shows Claude's response, so you hand off the idea and get back to what you were doing; the results are waiting when you get home. Notes are end-to-end encrypted on the watch, and the relay in between only sees ciphertext. Pair once with a short code (`/watch-notes:pair`), then run `/loop 5m /watch-notes:inbox`, or use channel mode for instant delivery. Zero dependencies, open source, MIT licensed.

## Draft: GitHub feature request (anthropics/claude-code)

**Title:** Channels: a path for community channel plugins to be allowlisted

**Body:**
I built [Watch Notes](https://github.com/maxvbuda/claude-watch-notes-mcp), a channel plugin that lets you send ideas from an Apple Watch app to a running Claude Code session. The note shows up in the session and Claude starts on it while you're away.

Right now every user has to start Claude Code with `--dangerously-load-development-channels`, and the warning screen understandably scares people off. The docs say `claude-plugins-official` doesn't take submissions and the community marketplace isn't on the channel allowlist, so there's no route to approval for an independent developer.

Could there be a review path for community channels? For example, a security review against the channel guidelines that adds a plugin to the allowlist. Watch Notes is built to the channels reference: sender gating through end-to-end encryption, a pairing code, no permission relay, zero dependencies, `claude plugin validate --strict` passing, and a full test suite. I'd be glad to have it be the first one reviewed.

## Draft: note to an Anthropic contact

> Hi! I built Watch Notes, an open-source Claude Code channel plugin plus an Apple Watch app: you jot ideas on your wrist and they land in your running Claude Code session. It's built to the channels reference (end-to-end encrypted sender gating, pairing code, no permission relay, zero deps, strict validation and tests). Right now users need `--dangerously-load-development-channels`, which scares people off. Would you consider it for `claude-plugins-official`, or point me to the right person? Repo: https://github.com/maxvbuda/claude-watch-notes-mcp
