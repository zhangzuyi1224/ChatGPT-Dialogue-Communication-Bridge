import { spawn } from "node:child_process";
import readline from "node:readline";

export class AppServerError extends Error {
  constructor(message, data) {
    super(message);
    this.name = "AppServerError";
    this.data = data;
  }
}

export class AppServerClient {
  constructor({ command = "codex", mode = "proxy", socket, url, timeoutMs = 15_000 } = {}) {
    this.command = command;
    this.mode = mode;
    this.socket = socket;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  async connect() {
    if (this.mode === "websocket") {
      if (!this.url) throw new AppServerError("WebSocket transport requires a url");
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(this.url);
        this.socketClient = socket;
        const timer = setTimeout(() => reject(new AppServerError(`Timed out connecting to ${this.url}`)), this.timeoutMs);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new AppServerError(`Could not connect to ${this.url}`)); }, { once: true });
        socket.addEventListener("message", (event) => this.#onLine(String(event.data)));
        socket.addEventListener("close", () => this.#rejectPending(new AppServerError("App Server WebSocket closed")));
      });
      await this.request("initialize", {
        clientInfo: { name: "codex_thread_bridge", title: "Codex Thread Bridge", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      });
      this.notify("initialized", {});
      return this;
    }
    const args = this.mode === "proxy"
      ? ["app-server", "proxy", ...(this.socket ? ["--sock", this.socket] : [])]
      : ["app-server"];
    this.proc = spawn(this.command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.stderr = "";
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.proc.once("exit", (code) => {
      const error = new AppServerError(`App Server exited with code ${code}. ${this.stderr.trim()}`);
      this.#rejectPending(error);
    });
    const lines = readline.createInterface({ input: this.proc.stdout });
    lines.on("line", (line) => this.#onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "codex_thread_bridge", title: "Codex Thread Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
    return this;
  }

  #rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #send(message) {
    const encoded = JSON.stringify(message);
    if (this.mode === "websocket") {
      if (this.socketClient?.readyState !== WebSocket.OPEN) throw new AppServerError("App Server WebSocket is not connected");
      this.socketClient.send(encoded);
      return;
    }
    if (!this.proc?.stdin?.writable) throw new AppServerError("App Server is not connected");
    this.proc.stdin.write(`${encoded}\n`);
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppServerError(message.error.message ?? "App Server request failed", message.error));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
    if (this.notifications.length > 1000) this.notifications.shift();
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#send({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  readThread(threadId, includeTurns = false) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  resumeThread(threadId) {
    return this.request("thread/resume", { threadId });
  }

  startTurn(threadId, text) {
    return this.request("turn/start", { threadId, input: [{ type: "text", text }] });
  }

  steerTurn(threadId, turnId, text) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }]
    });
  }

  close() {
    if (this.socketClient) this.socketClient.close();
    if (this.proc?.stdin?.writable) this.proc.stdin.end();
    if (this.proc && !this.proc.killed) this.proc.kill();
  }
}
