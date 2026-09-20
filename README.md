# Codex 任务通信桥

[简体中文](README.md) | [English](README.en.md)

这是一个 MCP Server，用于让已有的 Codex 桌面任务交换带来源标记、轮数受限的消息，同时避免为同一个任务启动相互竞争的执行器。

它提供三个 MCP 工具：

- `send_message(target, message, sender?, hop?)`：向指定任务发送消息。
- `read_updates(target, cursor?)`：增量读取任务消息。
- `get_status(target)`：读取任务在桥接 App Server 中的状态。

## 工作原理

```text
Codex 任务 A
    │ 调用 MCP 工具
    ▼
Codex Thread Bridge
    ├─ 查找目标任务的桌面所有者
    ├─ 目标运行中：追加到当前轮次
    └─ 目标空闲：启动一个新轮次
    ▼
Codex 任务 B
```

桥接程序优先查找当前拥有目标 thread 的桌面客户端。目标正在运行时，它会向当前轮次追加消息；目标空闲时，才会启动新一轮。这样可以避免两个 App Server 同时续写同一个任务。

## 安全设计

- 每条桥接消息都包含发送者、UUID 和 hop 计数。
- `maxAutomaticHops` 限制自动互相唤醒的最大轮数。
- 无法确认目标任务已经空闲时，拒绝创建新执行器。
- 默认禁止通过独立 App Server 修改桌面正在拥有的任务。
- `read_updates` 返回的 cursor 是不透明值，必须原样传回。
- 真实配置、运行日志、PID、会话记录和环境文件均被 Git 忽略。

在 Windows 上，`src/desktop-ipc-client.mjs` 会通过 Codex 桌面应用的私有 `codex-ipc` 协调管道查找 thread 所有者，然后转发 `thread-follower-steer-turn` 或 `thread-follower-start-turn` 请求。

> [!WARNING]
> `codex-ipc` 所有者转发协议不是公开稳定接口，Codex Desktop 升级后可能发生变化。公开的 Codex App Server 接口仍作为后备传输层；升级桌面应用后应重新验证私有兼容层。

## 环境要求

- 支持全局 `WebSocket` API 的 Node.js
- 命令行中可以使用 `codex`
- Windows（桌面任务所有者转发功能）

## 快速开始

复制示例配置：

```powershell
Copy-Item bridge.config.example.json bridge.config.json
```

编辑 `bridge.config.json`，把示例别名、thread ID 和 rollout 路径替换为本机真实值。不要提交这个文件。

启动桥接 App Server 并运行测试：

```powershell
./scripts/start-app-server.ps1
npm test
node src/cli.mjs status writer
```

启动脚本会在 `ws://127.0.0.1:47635` 创建一个隐藏的、仅监听本机回环地址的 App Server。停止服务：

```powershell
./scripts/stop-app-server.ps1
```

## 注册 MCP Server

使用 Codex CLI 注册：

```powershell
codex mcp add codex_thread_bridge `
  --env CODEX_BRIDGE_CONFIG=C:/path/to/codex-thread-bridge/bridge.config.json `
  -- node C:/path/to/codex-thread-bridge/src/mcp-server.mjs
```

也可以在 Codex 配置中添加等价配置：

```toml
[mcp_servers.codex_thread_bridge]
command = "node"
args = ["C:/path/to/codex-thread-bridge/src/mcp-server.mjs"]
env = { CODEX_BRIDGE_CONFIG = "C:/path/to/codex-thread-bridge/bridge.config.json" }
```

注册后，Codex 任务可以调用：

```text
send_message(target="reviewer", message="请检查最新结果")
read_updates(target="reviewer", cursor=null)
get_status(target="reviewer")
```

## 配置说明

每个 `targets` 项可以直接填写 thread ID，也可以使用包含以下字段的对象：

- `threadId`：Codex 桌面任务的 thread ID。
- `rolloutPath`：对应的本机会话 JSONL 路径，用于从 App Server 之外确认任务是否已经结束。

关键安全配置：

```json
{
  "safety": {
    "maxAutomaticHops": 4,
    "allowIsolatedSend": false
  }
}
```

建议始终保持 `allowIsolatedSend: false`，除非可以确定没有桌面 App Server 拥有相同任务。

## CLI 用法

```powershell
node src/cli.mjs status writer
node src/cli.mjs read writer
node src/cli.mjs send writer "请继续处理当前任务"
node src/cli.mjs owner writer
```

`read` 命令返回的 cursor 可用于下一次增量读取：

```powershell
node src/cli.mjs read writer "上一次返回的完整 cursor"
```

不要使用自定义标签代替 cursor。

## 注意事项

- Codex 桌面 thread ID 与 OpenAI Agents API session ID 是两类不同标识，不能混用。
- `notLoaded` 只表示专用桥接 App Server 没有加载该任务，不能证明桌面端没有拥有它。
- 修改 MCP 注册后，可能需要让桌面应用刷新或重新启动对应 MCP 进程。
- 不要提交 Codex rollout 文件；其中可能包含完整对话、任务 ID 和本地路径。
- 上传公开仓库前，建议再次扫描用户名、绝对路径、thread ID、令牌和私钥。

公开接口请参考官方 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)和 [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。

## 许可证

[MIT](LICENSE)
