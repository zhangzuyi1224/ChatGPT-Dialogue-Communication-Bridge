import readline from "node:readline";
import { createBridge } from "./bridge.mjs";

const bridge = await createBridge(process.env.CODEX_BRIDGE_CONFIG);
const input = readline.createInterface({ input: process.stdin });

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function ok(id, result) { write({ jsonrpc: "2.0", id, result }); }
function fail(id, error) { write({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } }); }
function toolResult(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }

const tools = [
  {
    name: "send_message",
    description: "Send a labeled message to a configured Codex task. Steers an active turn; starts a turn only when idle.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" }, sender: { type: "string" }, hop: { type: "integer", minimum: 0 } }, required: ["target", "message"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "read_updates",
    description: "Read task messages after an opaque cursor without starting or resuming the task.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, cursor: { type: ["string", "null"] } }, required: ["target"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_status",
    description: "Read a configured Codex task runtime status without resuming it.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

input.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") return ok(request.id, { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "codex-thread-bridge", version: "0.1.0" } });
    if (request.method === "ping") return ok(request.id, {});
    if (request.method === "tools/list") return ok(request.id, { tools });
    if (request.method === "tools/call") {
      const { name, arguments: args = {} } = request.params ?? {};
      if (name === "get_status") return ok(request.id, toolResult(await bridge.getStatus(args.target)));
      if (name === "read_updates") return ok(request.id, toolResult(await bridge.readUpdates(args.target, args.cursor)));
      if (name === "send_message") return ok(request.id, toolResult(await bridge.sendMessage(args.target, args.message, { sender: args.sender, hop: args.hop })));
      throw new Error(`Unknown tool: ${name}`);
    }
    ok(request.id, {});
  } catch (error) { fail(request.id, error); }
});
