# Privacy Policy: Handoff

_Last updated: October 8, 2026_

Handoff has two parts: an Apple Watch app and a Claude Code plugin that runs on your own Mac. The developer runs no servers and collects no data.

## What the watch app does with your notes

- Notes you write are stored on your watch until they're delivered, and the 12 most recent are kept as a history list.
- Each note is encrypted on the watch with AES-256-GCM, using a key that only your watch and your Mac have. It's then sent to a public relay, [ntfy.sh](https://ntfy.sh), on a random topic.
- The relay only ever sees encrypted data. It can't read your notes. ntfy.sh keeps messages for up to about 12 hours, and see ntfy's own [privacy policy](https://ntfy.sh/docs/privacy/). Like any web service, it can see your IP address.
- The encryption key is stored in the watch's Keychain and never leaves your devices, except once, during pairing, when it's sent to your Mac encrypted with a key derived from the one-time pairing code.

## What the Mac plugin does

- It downloads your encrypted notes from the relay, decrypts them, and saves them in `~/.claude-watch-notes/` on your Mac.
- It passes each note to your Claude Code session. Claude Code then processes it under your Anthropic account, like anything you type into Claude Code. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- When Claude finishes a note, it records a short summary with the plugin's `watch_note_done` tool. The summary is saved in the same place, on your Mac only, and is never sent to the relay or anywhere else.
- Claude can also include a one-line suggested next prompt. It's encrypted with the same key and sent through the relay to the watch, which shows it with an **Accept suggestion** button. Claude's response itself is never sent to the watch.
- Each Claude Code session started with `handoff start` sends the watch its chat name (your folder's name, or one you choose) about once a minute, encrypted, so the watch can list open chats. Notes you address to a chat carry that name too.

## What `handoff host` does (optional)

If you run `handoff host` on your Mac, the watch can start new chats:

- It sends the watch the names of the folders inside the folder you gave it, encrypted, so you can browse them. Only folder names are sent, never file names or file contents.
- When you pick a folder on the watch, it registers a chat there. If you ask for a new folder, it creates that empty folder first. It can't reach anything outside the folder you gave it.
- Each note you send to that chat is run by Claude Code on your Mac (`claude -p`) in that folder, under your Anthropic account, like the rest of Handoff. A log of what Claude did is saved in `~/.claude-watch-notes/logs/`, and the list of chats in `~/.claude-watch-notes/host-chats.json`. Neither leaves your Mac.

## Everything that travels through the relay

All of it is encrypted with your key, so ntfy.sh can't read any of it:

| Topic | From → to | Contents |
| --- | --- | --- |
| `cw-…` | watch → Mac | your notes, and the chat each is for |
| `cw-…-s` | Mac → watch | Claude's suggested next prompt |
| `cw-…-c` | Mac → watch | open chat names; the host's chat names and top-level folder names |
| `cw-…-n` | watch → Mac | requests to the host: list a folder, start a chat, make a folder |
| `cw-…-l` | Mac → watch | subfolder names, in reply to a list request |

## How long data is kept

- **On your Mac:** notes, Claude's summaries, and host chat logs stay in `~/.claude-watch-notes/` until you delete them.
- **On the watch:** up to 12 notes of history (until you delete them in Settings), your draft, the last suggestion, and your chosen chat.
- **On the relay (ntfy.sh):** encrypted messages for up to about 12 hours, and file attachments (notes of 4 KB or more) for about 3 hours.
- **By the developer:** nothing, because no data ever reaches the developer.

## What we collect

Nothing. There are no analytics, accounts, advertising, or tracking, and no servers operated by the developer.

## Deleting your data

Unpair in the app, delete the app, and delete `~/.claude-watch-notes/` on your Mac.

## Contact

Questions: open an issue at https://github.com/maxvbuda/claude-watch-notes-mcp/issues.
