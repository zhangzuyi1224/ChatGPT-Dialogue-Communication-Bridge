import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeCursor, encodeCursor, extractMessages, inspectRolloutTail, resolveTarget, ThreadBridge } from "../src/bridge.mjs";
import { encodeFrame, FrameDecoder } from "../src/desktop-ipc-client.mjs";

test("target aliases and cursors are scoped to a thread", () => {
  const config = { targets: { paper: "11111111-1111-4111-8111-111111111111" } };
  assert.equal(resolveTarget(config, "paper").threadId, config.targets.paper);
  const cursor = encodeCursor(config.targets.paper, 3);
  assert.equal(decodeCursor(cursor, config.targets.paper), 3);
  assert.throws(() => decodeCursor(cursor, "22222222-2222-4222-8222-222222222222"));
});

test("extractMessages returns only message items", () => {
  const thread = { turns: [{ id: "t1", items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "hello" }] },
    { id: "cmd", type: "commandExecution", text: "ignore" },
    { id: "a1", type: "agentMessage", content: [{ type: "output_text", text: "world" }] }
  ] }] };
  assert.deepEqual(extractMessages(thread).map((x) => x.text), ["hello", "world"]);
});

test("isolated transport refuses mutation by default", async () => {
  const bridge = new ThreadBridge({ transport: { mode: "spawn" }, targets: { paper: "11111111-1111-4111-8111-111111111111" }, safety: { allowIsolatedSend: false } });
  await assert.rejects(() => bridge.sendMessage("paper", "hello"), /Refusing to send/);
});

test("rollout guard distinguishes completed and in-progress turns", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
  const completed = path.join(dir, "completed.jsonl");
  const active = path.join(dir, "active.jsonl");
  await fs.writeFile(completed, [
    JSON.stringify({ type: "turn_context", payload: {} }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ""
  ].join("\n"));
  await fs.writeFile(active, [
    JSON.stringify({ type: "turn_context", payload: {} }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
    ""
  ].join("\n"));
  assert.equal((await inspectRolloutTail(completed)).terminal, true);
  assert.equal((await inspectRolloutTail(active)).terminal, false);
});

test("desktop IPC framing survives split chunks", () => {
  const message = { type: "response", requestId: "r1", resultType: "success" };
  const frame = encodeFrame(message);
  const decoded = [];
  const decoder = new FrameDecoder((value) => decoded.push(value));
  decoder.push(frame.subarray(0, 3));
  decoder.push(frame.subarray(3, 9));
  decoder.push(frame.subarray(9));
  assert.deepEqual(decoded, [message]);
});
