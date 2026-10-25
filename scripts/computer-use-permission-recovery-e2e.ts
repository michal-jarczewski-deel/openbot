// Run the real runtime and MCP transport against a process that caches grants at startup.
// Optional: OPENBOT_E2E_CUA_DRIVER=/path/to/cua-driver also checks the real macOS driver.
// No permission prompts, input actions, or user-profile changes. Writes an ignored JSON report.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { CuaDriverRuntime } from "../src/main/cua-driver-runtime";

const out = resolve(import.meta.dirname, "../.openbot-build/computer-use-permission-recovery-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-permissions-"));
const socketRoot = await mkdtemp("/tmp/openbot-ax-");
const grants = join(root, "grants.json");
const driver = join(root, "driver");
const checks: { name: string; passed: boolean }[] = [];
const runtimes: CuaDriverRuntime[] = [];
let completed = false;

// The daemon reads the fixture once. Changing the file cannot change its cached answer.
// The MCP process forwards check_permissions through the real action tap.
await writeFile(
  driver,
  `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const socket = process.argv[process.argv.indexOf("--socket") + 1];
const answer = (output, value) => output.write(JSON.stringify(value) + "\\n");
if (process.argv[2] === "serve") {
  const cached = JSON.parse(fs.readFileSync(${JSON.stringify(grants)}, "utf8"));
  const server = net.createServer((connection) => {
    readline.createInterface({ input: connection }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "shutdown") { connection.end(); server.close(); process.exit(0); }
      const result = request.method === "sessions_list" ? { count: 0, sessions: [] } : {
        content: [{ type: "text", text: JSON.stringify(cached) }], structuredContent: cached
      };
      answer(connection, { ok: true, result });
    });
  });
  server.listen(socket);
} else if (process.argv[2] === "mcp") {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const reply = (result) => answer(process.stdout, { jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize") return reply({
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "permission-cache-fixture", version: "1" }
    });
    if (request.method === "tools/list") return reply({ tools: [] });
    if (request.method === "tools/call") {
      const connection = net.connect(socket, () => answer(connection, {
        method: "call", name: request.params.name, args: request.params.arguments,
        client_kind: "cli", session_id: "permission-cache-fixture"
      }));
      readline.createInterface({ input: connection }).once("line", (response) => {
        reply(JSON.parse(response).result); connection.end();
      });
    }
  }).on("close", () => process.exit(0));
}
`,
  { mode: 0o755 },
);

function rig(name: string, platform: NodeJS.Platform = "darwin", executable = driver) {
  const children: ChildProcess[] = [];
  const announcements = { count: 0 };
  const runtime = new CuaDriverRuntime({
    executable,
    endpoint: { kind: "unix-socket", directory: join(socketRoot, name) },
    supported: true,
    platform,
    hostBundleId: "app.openbot.desktop",
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    },
  });
  runtime.onMcpServerChanged(() => {
    announcements.count += 1;
  });
  runtimes.push(runtime);
  return { runtime, children, announcements };
}

async function grant(accessibility: boolean) {
  await writeFile(grants, JSON.stringify({ accessibility, screen_recording: true }));
}

function passed(name: string) {
  checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}

try {
  await grant(false);
  const denied = rig("denied");
  assert.equal((await Effect.runPromise(denied.runtime.state())).status, "permissions-required");
  assert.equal(denied.runtime.mcpServerForProviders(), null);
  const original = denied.children[0];
  assert.ok(original);

  await grant(true);
  assert.equal((await Effect.runPromise(denied.runtime.state())).status, "permissions-required");
  assert.equal(denied.children.length, 1);
  passed("passive polling retains the cached denied process");

  const [poll, first, second] = await Promise.all([
    Effect.runPromise(denied.runtime.state()),
    Effect.runPromise(denied.runtime.recheck()),
    Effect.runPromise(denied.runtime.recheck()),
  ]);
  assert.equal(poll.status, "permissions-required");
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(denied.children.length, 2);
  assert.notEqual(denied.children[1]?.pid, original.pid);
  assert.ok(denied.runtime.mcpServerForProviders());
  assert.equal(denied.announcements.count, 1);
  passed("concurrent rechecks replace one denied daemon and recover the grant");

  assert.equal((await Effect.runPromise(denied.runtime.recheck())).status, "ready");
  assert.equal(denied.children.length, 2);
  assert.equal(denied.announcements.count, 1);
  passed("a ready daemon and its provider tools remain in place");

  const stopped = denied.children[1];
  assert.ok(stopped);
  const exit = once(stopped, "exit");
  stopped.kill("SIGTERM");
  await exit;
  assert.equal((await Effect.runPromise(denied.runtime.recheck())).status, "ready");
  assert.equal(denied.children.length, 3);
  passed("recheck starts a replacement after a daemon exits");

  await grant(false);
  const stillDenied = rig("still-denied");
  await Effect.runPromise(stillDenied.runtime.state());
  assert.equal((await Effect.runPromise(stillDenied.runtime.recheck())).status, "permissions-required");
  assert.equal(stillDenied.runtime.mcpServerForProviders(), null);
  assert.equal(stillDenied.children.length, 2);
  await Effect.runPromise(stillDenied.runtime.state());
  assert.equal(stillDenied.children.length, 2);
  passed("an unchanged denial stays denied without a polling restart loop");

  const linux = rig("linux", "linux");
  assert.equal((await Effect.runPromise(linux.runtime.state())).status, "ready");
  assert.equal((await Effect.runPromise(linux.runtime.recheck())).status, "ready");
  assert.equal(linux.children.length, 1);
  passed("non-macOS checks keep their daemon");

  const nativeDriver = process.env.OPENBOT_E2E_CUA_DRIVER;
  if (nativeDriver) {
    assert.equal(process.platform, "darwin");
    const native = rig("native", process.platform, nativeDriver);
    const initial = await Effect.runPromise(native.runtime.state());
    assert.equal(initial.status, "ready", JSON.stringify(initial));
    assert.ok(initial.permissions.every((permission) => permission.granted));
    assert.equal((await Effect.runPromise(native.runtime.recheck())).status, "ready");
    assert.equal(native.children.length, 1);
    await Effect.runPromise(native.runtime.stop());
    assert.equal((await Effect.runPromise(native.runtime.recheck())).status, "ready");
    assert.equal(native.children.length, 2);
    passed("real bundled macOS driver reports both grants through the patched runtime");
  }
  completed = true;
} finally {
  for (const runtime of runtimes) await Effect.runPromise(runtime.stop());
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify({ passed: completed, checks }, null, 2));
  await rm(root, { recursive: true, force: true });
  await rm(socketRoot, { recursive: true, force: true });
}
