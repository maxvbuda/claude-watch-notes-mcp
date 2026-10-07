# Privacy Policy: Watch Notes

_Last updated: October 7, 2026_

Watch Notes has two parts: an Apple Watch app and a Claude Code plugin that runs on your own Mac. The developer runs no servers and collects no data.

## What the watch app does with your notes

- Notes you write are stored on your watch until they're delivered, and the 12 most recent are kept as a history list.
- Each note is encrypted on the watch with AES-256-GCM, using a key that only your watch and your Mac have. It's then sent to a public relay, [ntfy.sh](https://ntfy.sh), on a random topic.
- The relay only ever sees encrypted data. It can't read your notes. ntfy.sh keeps messages for up to about 12 hours, and see ntfy's own [privacy policy](https://ntfy.sh/docs/privacy/). Like any web service, it can see your IP address.
- The encryption key is stored in the watch's Keychain and never leaves your devices, except once, during pairing, when it's sent to your Mac encrypted with a key derived from the one-time pairing code.

## What the Mac plugin does

- It downloads your encrypted notes from the relay, decrypts them, and saves them in `~/.claude-watch-notes/` on your Mac.
- It passes each note to your Claude Code session. Claude Code then processes it under your Anthropic account, like anything you type into Claude Code. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- Nothing is sent back to the watch.

## What we collect

Nothing. There are no analytics, accounts, advertising, or tracking, and no servers operated by the developer.

## Deleting your data

Unpair in the app, delete the app, and delete `~/.claude-watch-notes/` on your Mac.

## Contact

Questions: open an issue at https://github.com/maxvbuda/claude-watch-notes-mcp/issues.
