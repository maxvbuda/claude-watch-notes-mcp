# Handoff

Jot ideas on your Apple Watch; Claude Code works on them while you're away. The watch never shows Claude's response, so there's nothing to get pulled into. Only a one-line suggested next prompt comes back, with an Accept suggestion button.

This plugin is the Mac side: an MCP server (and Claude Code channel) that receives your watch's end-to-end encrypted notes and hands them to Claude. The watch app and full docs live in the [repository](https://github.com/maxvbuda/claude-watch-notes-mcp).

- `/handoff:pair`: pair your watch
- `/handoff:inbox`: work on pending ideas (or `/loop 5m /handoff:inbox` without channels)
- `handoff start`: open a session that receives ideas instantly (channel mode)

## Data and network use

- **External service:** the plugin uses the public [ntfy.sh](https://ntfy.sh) relay. It's the only service it contacts. The MCP server receives your watch's notes from ntfy.sh and sends back Claude's optional one-line suggestion, and the `pair` skill exchanges pairing messages through it. Everything sent through ntfy.sh is end-to-end encrypted (AES-256-GCM) with a key only your watch and Mac have; ntfy.sh only sees ciphertext on a random topic.
- **Stored data:** decrypted notes are saved locally in `~/.claude-watch-notes/` on your Mac until you delete them.
- **No developer servers, accounts, or analytics.** Full details are in [PRIVACY.md](https://github.com/maxvbuda/claude-watch-notes-mcp/blob/main/PRIVACY.md).
