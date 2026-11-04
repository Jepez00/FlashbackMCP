# Flashback MCP source server

[English installation guide](../README.md) · [Guida in italiano](../README.it.md)

This is the editable source version. Keep `server.mjs` and `tools.json` together.
It requires Node.js 18+ and no npm dependencies.

```sh
node "/absolute/path/to/mcp-server/server.mjs" --print-config codex
```

Supported configuration formats: `codex`, `claude`, `cursor`, `gemini`, `vscode`, `generic`.
The command only prints settings. Start the MCP server without any arguments.

For the single-file distribution, use `flashback-mcp-server.mjs` in the repository
root or download it from [Releases](https://github.com/Jepez00/FlashbackMCP/releases).
Rebuild it with `npm run build` from the repository root after changing the source
or tool catalog.
