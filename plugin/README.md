# Watch Notes

Jot ideas on your Apple Watch; Claude Code works on them while you're away. The watch never shows Claude's response, so there's nothing to get pulled into.

This plugin is the Mac side: an MCP server (and Claude Code channel) that receives your watch's end-to-end encrypted notes and hands them to Claude. The watch app and full docs live in the [repository](https://github.com/maxvbuda/claude-watch-notes-mcp).

- `/watch-notes:pair`: pair your watch
- `/watch-notes:inbox`: work on pending ideas (or `/loop 5m /watch-notes:inbox` without channels)
- `watch-notes start`: open a session that receives ideas instantly (channel mode)
