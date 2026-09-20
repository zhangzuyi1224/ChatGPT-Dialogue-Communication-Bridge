# Codex Thread Bridge

[简体中文](README.md) | [English](README.en.md)

An MCP server that lets existing Codex desktop tasks exchange bounded, labeled messages without starting a competing writer.

It exposes three tools:

- `send_message(target, message, sender?, hop?)`
- `read_updates(target, cursor?)`
- `get_status(target)`

## Safety model

- Active work is extended through the owning desktop client; idle work starts a new turn.
- Every message carries a sender, UUID, and bounded hop count.
- If external task activity cannot be proven finished, the bridge refuses to create a new executor.
- Isolated App Server mutation is disabled by default.
- `read_updates` cursors are opaque and must be reused unchanged.

On Windows, `src/desktop-ipc-client.mjs` uses the Codex desktop app's private `codex-ipc` coordination pipe to discover the thread owner and forward `thread-follower-steer-turn` or `thread-follower-start-turn`. This protocol is undocumented and may change in future desktop releases. The public Codex App Server transport remains the fallback backend.

## Requirements

- Node.js with the global `WebSocket` API
- Codex CLI available as `codex`
- Windows for desktop-owner forwarding

## Setup

Copy the example configuration and replace its aliases, thread IDs, and rollout paths with local values:

```powershell
Copy-Item bridge.config.example.json bridge.config.json
./scripts/start-app-server.ps1
npm test
node src/cli.mjs status writer
```

The startup script launches a hidden, loopback-only bridge App Server at `ws://127.0.0.1:47635`. Use `scripts/stop-app-server.ps1` to stop it.

Register the MCP server with Codex:

```powershell
codex mcp add codex_thread_bridge `
  --env CODEX_BRIDGE_CONFIG=C:/path/to/codex-thread-bridge/bridge.config.json `
  -- node C:/path/to/codex-thread-bridge/src/mcp-server.mjs
```

Alternatively, add an equivalent entry to Codex configuration:

```toml
[mcp_servers.codex_thread_bridge]
command = "node"
args = ["C:/path/to/codex-thread-bridge/src/mcp-server.mjs"]
env = { CODEX_BRIDGE_CONFIG = "C:/path/to/codex-thread-bridge/bridge.config.json" }
```

## Configuration

Each target may be a thread ID string or an object containing `threadId` and `rolloutPath`. The rollout path is used as an external activity guard when the dedicated bridge App Server reports the thread as `notLoaded`.

The real `bridge.config.json`, runtime logs, PID files, generated schemas, environment files, and dependencies are ignored by Git. Do not commit session rollouts: they may contain full conversation history and local paths.

## Notes

- Codex desktop thread IDs are not OpenAI Agents API session IDs.
- A `notLoaded` status describes the dedicated bridge App Server's local view; it does not prove that the desktop owner is absent.
- MCP registration changes may require the desktop app to refresh or restart the affected MCP process.
- Revalidate the private Windows IPC compatibility layer after Codex desktop upgrades.

See the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) and [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) for the supported public interfaces.

## License

[MIT](LICENSE)
