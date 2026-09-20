import net from "node:net";
import { randomUUID } from "node:crypto";

const DEFAULT_PIPE = "\\\\.\\pipe\\codex-ipc";
const METHOD_VERSIONS = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1
};

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > 256 * 1024 * 1024) throw new Error(`Invalid desktop IPC frame length: ${length}`);
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      this.onMessage(JSON.parse(body));
    }
  }
}

export class DesktopIpcClient {
  constructor({ pipePath = DEFAULT_PIPE, timeoutMs = 10_000, clientType = "codex_thread_bridge" } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.clientType = clientType;
    this.clientId = "initializing-client";
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      this.socket = socket;
      const decoder = new FrameDecoder((message) => this.#onMessage(message));
      socket.on("data", (chunk) => decoder.push(chunk));
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.on("close", () => this.#rejectAll(new Error("Desktop IPC connection closed")));
    });
    const response = await this.request("initialize", { clientType: this.clientType }, { version: 0 });
    if (response.resultType !== "success" || !response.result?.clientId) throw new Error(`Desktop IPC initialize failed: ${response.error ?? "unknown error"}`);
    this.clientId = response.result.clientId;
    return this;
  }

  #onMessage(message) {
    if (message.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }
    if (message.type === "client-discovery-request") {
      this.socket.write(encodeFrame({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      }));
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, { targetClientId, hostId, version = METHOD_VERSIONS[method] ?? 0, timeoutMs = this.timeoutMs } = {}) {
    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
      ...(hostId ? { hostId } : {}),
      timeoutMs
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Desktop IPC request timed out: ${method}`));
      }, timeoutMs + 500);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeFrame(message));
    });
  }

  async findThreadOwner(threadId, hostId = "local") {
    const response = await this.request("thread-owner-discovery", { hostId, conversationId: threadId });
    if (response.resultType === "error" && response.error === "no-client-found") return null;
    if (response.resultType !== "success") throw new Error(`Owner discovery failed: ${response.error ?? "unknown error"}`);
    return { clientId: response.handledByClientId, capabilities: response.result ?? {} };
  }

  async steerThread(ownerClientId, threadId, text) {
    const response = await this.request("thread-follower-steer-turn", {
      conversationId: threadId,
      input: [{ type: "text", text, text_elements: [] }],
      restoreMessage: null,
      serviceTier: null,
      attachments: [],
      clientUserMessageId: randomUUID(),
      additionalContext: null,
      toolOutput: null
    }, { targetClientId: ownerClientId });
    if (response.resultType !== "success") throw new Error(`Desktop steer failed: ${response.error ?? "unknown error"}`);
    return response.result;
  }

  async startThread(ownerClientId, threadId, text) {
    const response = await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: {
        request: {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          turnTrigger: "user"
        },
        context: {
          attachments: [],
          commentAttachments: [],
          inheritThreadSettings: true,
          responseItems: []
        }
      }
    }, { targetClientId: ownerClientId, timeoutMs: 30_000 });
    if (response.resultType !== "success") throw new Error(`Desktop start failed: ${response.error ?? "unknown error"}`);
    return response.result;
  }

  close() {
    this.socket?.destroy();
  }
}
