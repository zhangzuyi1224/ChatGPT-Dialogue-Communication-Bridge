import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.mjs";
import { DesktopIpcClient } from "./desktop-ipc-client.mjs";

export const DEFAULT_CONFIG = path.resolve("bridge.config.json");

export async function loadConfig(configPath = DEFAULT_CONFIG) {
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

export function resolveTarget(config, target) {
  const configured = config.targets[target];
  const threadId = typeof configured === "string" ? configured : configured?.threadId ?? target;
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error(`Unknown target: ${target}`);
  return { alias: configured ? target : null, threadId, rolloutPath: typeof configured === "object" ? configured.rolloutPath : null };
}

export async function inspectRolloutTail(rolloutPath, maxBytes = 2 * 1024 * 1024) {
  if (!rolloutPath) return { verifiable: false, terminal: false, reason: "no rolloutPath configured" };
  const handle = await fs.open(rolloutPath, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    let lastTurnIndex = -1;
    const parsed = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        parsed.push(event);
        if (event.type === "turn_context") lastTurnIndex = parsed.length - 1;
      } catch {}
    }
    const currentTurnEvents = parsed.slice(lastTurnIndex + 1);
    const terminalEvent = [...currentTurnEvents].reverse().find((event) =>
      event.type === "event_msg" && ["task_complete", "turn_aborted"].includes(event.payload?.type)
    );
    return {
      verifiable: true,
      terminal: Boolean(terminalEvent),
      terminalType: terminalEvent?.payload?.type ?? null,
      lastWriteMs: stat.mtimeMs
    };
  } finally {
    await handle.close();
  }
}

function activeTurnId(thread) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return [...turns].reverse().find((turn) => /progress|active|running/i.test(String(turn.status)))?.id ?? null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? part?.content ?? "").filter(Boolean).join("\n");
}

export function extractMessages(thread) {
  const messages = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      const type = String(item.type ?? "");
      if (!/message/i.test(type)) continue;
      const text = textFromContent(item.content ?? item.text);
      if (!text) continue;
      const role = item.role ?? (/user/i.test(type) ? "user" : "assistant");
      messages.push({ id: item.id ?? `${turn.id}:${messages.length}`, turnId: turn.id, role, text });
    }
  }
  return messages;
}

export function encodeCursor(threadId, offset) {
  return Buffer.from(JSON.stringify({ threadId, offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor, threadId) {
  if (!cursor) return 0;
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (parsed.threadId !== threadId || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
    throw new Error("Cursor does not belong to this target");
  }
  return parsed.offset;
}

export class ThreadBridge {
  constructor(config, { configPath = DEFAULT_CONFIG, clientFactory } = {}) {
    this.config = config;
    this.configPath = configPath;
    this.clientFactory = clientFactory ?? ((transport) => new AppServerClient(transport));
  }

  async #sendThroughDesktopOwner(resolved, wrapped) {
    if (this.config.desktopIpc?.enabled !== true) return null;
    const ipc = new DesktopIpcClient({ pipePath: this.config.desktopIpc.pipePath });
    try {
      await ipc.connect();
      const owner = await ipc.findThreadOwner(resolved.threadId);
      if (!owner) return null;
      const external = await inspectRolloutTail(resolved.rolloutPath);
      if (!external.verifiable) throw new Error("Desktop owns the target, but rollout activity could not be verified");
      if (external.terminal) {
        const result = await ipc.startThread(owner.clientId, resolved.threadId, wrapped);
        return { method: "thread-follower-start-turn", ownerClientId: owner.clientId, result };
      }
      const result = await ipc.steerThread(owner.clientId, resolved.threadId, wrapped);
      return { method: "thread-follower-steer-turn", ownerClientId: owner.clientId, result };
    } finally {
      ipc.close();
    }
  }

  async #withClient(fn) {
    const client = this.clientFactory(this.config.transport);
    await client.connect();
    try { return await fn(client); } finally { client.close(); }
  }

  async getStatus(target) {
    const resolved = resolveTarget(this.config, target);
    return this.#withClient(async (client) => {
      const result = await client.readThread(resolved.threadId, false);
      return {
        target: resolved.alias ?? resolved.threadId,
        threadId: resolved.threadId,
        status: result.thread?.status ?? null,
        transportMode: this.config.transport.mode,
        sendEnabled: ["proxy", "websocket"].includes(this.config.transport.mode) || this.config.safety?.allowIsolatedSend === true
      };
    });
  }

  async readUpdates(target, cursor = null) {
    const resolved = resolveTarget(this.config, target);
    return this.#withClient(async (client) => {
      const result = await client.readThread(resolved.threadId, true);
      const all = extractMessages(result.thread ?? {});
      const offset = decodeCursor(cursor, resolved.threadId);
      return {
        target: resolved.alias ?? resolved.threadId,
        threadId: resolved.threadId,
        updates: all.slice(offset),
        cursor: encodeCursor(resolved.threadId, all.length),
        status: result.thread?.status ?? null
      };
    });
  }

  async sendMessage(target, message, { sender = "bridge", hop = 0 } = {}) {
    if (!message?.trim()) throw new Error("message must be non-empty");
    const maxHops = this.config.safety?.maxAutomaticHops ?? 4;
    if (!Number.isInteger(hop) || hop < 0 || hop > maxHops) throw new Error(`hop must be between 0 and ${maxHops}`);
    if (!["proxy", "websocket"].includes(this.config.transport.mode) && this.config.safety?.allowIsolatedSend !== true) {
      throw new Error("Refusing to send through an isolated App Server. Attach through proxy/socket or explicitly enable allowIsolatedSend.");
    }
    const resolved = resolveTarget(this.config, target);
    const messageId = randomUUID();
    const wrapped = `[bridge sender=${sender} message_id=${messageId} hop=${hop}/${maxHops}]\n${message.trim()}`;
    try {
      const desktopDelivery = await this.#sendThroughDesktopOwner(resolved, wrapped);
      if (desktopDelivery) {
        return { target: resolved.alias ?? resolved.threadId, threadId: resolved.threadId, messageId, delivery: desktopDelivery };
      }
    } catch (error) {
      if (!/no-client-found|client-cannot-handle-request/i.test(error.message)) throw error;
    }
    return this.#withClient(async (client) => {
      const read = await client.readThread(resolved.threadId, true);
      const thread = read.thread ?? {};
      const type = thread.status?.type;
      let delivery;
      if (type === "active") {
        const turnId = activeTurnId(thread);
        if (!turnId) throw new Error("Target is active but its active turn id was not available; refusing to create a competing turn.");
        await client.steerTurn(resolved.threadId, turnId, wrapped);
        delivery = { method: "turn/steer", turnId };
      } else {
        if (type === "notLoaded") {
          const external = await inspectRolloutTail(resolved.rolloutPath);
          if (!external.verifiable || !external.terminal) {
            throw new Error("Target is not loaded in the bridge App Server, but its external rollout is not confirmed idle; refusing to create a competing executor.");
          }
          await client.resumeThread(resolved.threadId);
        }
        const started = await client.startTurn(resolved.threadId, wrapped);
        delivery = { method: "turn/start", turnId: started.turn?.id ?? null };
      }
      return { target: resolved.alias ?? resolved.threadId, threadId: resolved.threadId, messageId, delivery };
    });
  }
}

export async function createBridge(configPath = DEFAULT_CONFIG) {
  return new ThreadBridge(await loadConfig(configPath), { configPath });
}
