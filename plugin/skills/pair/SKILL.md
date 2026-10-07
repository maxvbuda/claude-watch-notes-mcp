---
name: pair
description: Pair an Apple Watch running the Watch Notes app with this Mac. Use when the user wants to set up, connect, or re-pair their watch.
disable-model-invocation: true
---

Pair the user's Apple Watch with this Mac.

1. Run this in the background (it waits up to 10 minutes for the watch):
   `node "${CLAUDE_PLUGIN_ROOT}/server/watch-notes.mjs" pair`
2. As soon as it prints `Pairing code:  XXXX-XXXX`, show the user that code in large, clear text and tell them to open Watch Notes on their watch and type it in. Uppercase or lowercase is fine; the dash is optional.
3. Wait for the command to finish. If it prints `Paired.`, tell the user they're set, and that ideas will reach any session started with `watch-notes start`. If it times out, offer to run it again for a new code.
