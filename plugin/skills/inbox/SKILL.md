---
name: inbox
description: Check for ideas sent from the user's Apple Watch and work on any that are pending. Use when the user asks about watch notes, or on a /loop to poll without channels.
---

Call the `watch_inbox` tool from the watch-notes server.

- If there are no pending notes, say so in one short line and stop.
- Otherwise, handle each pending note as its own task, oldest first, following the watch-notes server instructions: the user is away, so work autonomously, make reasonable assumptions, skip (and list) anything the permission system blocks, and call `watch_note_done` with a short summary when each note is finished.

To keep checking without channels, the user can run `/loop 5m /watch-notes:inbox`.
