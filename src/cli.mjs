import { createBridge } from "./bridge.mjs";
import { DesktopIpcClient } from "./desktop-ipc-client.mjs";

const [command, target, ...rest] = process.argv.slice(2);
const bridge = await createBridge(process.env.CODEX_BRIDGE_CONFIG);
try {
  let result;
  if (command === "status") result = await bridge.getStatus(target);
  else if (command === "read") result = await bridge.readUpdates(target, rest[0] || null);
  else if (command === "send") result = await bridge.sendMessage(target, rest.join(" "));
  else if (command === "owner") {
    const resolved = bridge.config.targets[target];
    const threadId = typeof resolved === "string" ? resolved : resolved?.threadId ?? target;
    const ipc = await new DesktopIpcClient().connect();
    try { result = await ipc.findThreadOwner(threadId); } finally { ipc.close(); }
  }
  else throw new Error("Usage: node src/cli.mjs status|read|send|owner <target> [message|cursor]");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
