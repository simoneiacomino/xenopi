import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveXenolithSettings } from "../../src/config.js";
import { packageRoot } from "../../src/launcher.js";
import { xenolithServiceArgs } from "../../src/wire/client.js";
import { describeService } from "../../src/wire/describe.js";
import { applyInspection, inspectService } from "../../src/wire/discovery.js";
import { MockWireServer } from "./mock-wire.js";

const execFileAsync = promisify(execFile);

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "xenopi native config "));
  const bin = join(root, "fake-engine.mjs");
  const data = join(root, "inspection.json");
  const mode = join(root, "mode");
  const trace = join(root, "trace.jsonl");
  const pid = join(root, "engine.pid");
  const response = {
    schema_version: 1,
    config_path: join(root, "config.json"),
    config_present: true,
    endpoint: { transport: "unix", path: join(root, "runtime", "wire.sock") },
    state_dir: join(root, "state"),
    cache_dir: join(root, "cache"),
    engine_lock: join(root, "global-state", "engine.lock"),
    log_path: join(root, "state", "service.log"),
  };
  writeFileSync(data, JSON.stringify(response));
  writeFileSync(mode, "ok");
  const mockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "mock-wire.js")).href;
  writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { MockWireServer } from ${JSON.stringify(mockUrl)};
const args = process.argv.slice(2);
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
if (args[0] === "config") {
  const mode = readFileSync(${JSON.stringify(mode)}, "utf8");
  if (mode === "old") { process.stderr.write("Usage: xenolith <command> <model.gguf> [options]\\n  serve    [options]\\n"); process.exit(1); }
  if (mode === "error") { process.stderr.write("xenolith: invalid configuration: context must be an integer\\n"); process.exit(1); }
  if (mode === "invalid") { process.stdout.write("not JSON"); process.exit(0); }
  if (mode === "large") { process.stdout.write("x".repeat(70000)); setInterval(() => {}, 1000); }
  else if (mode === "timeout") { setInterval(() => {}, 1000); }
  else {
    const info = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
    if (flag("--config")) info.config_path = flag("--config");
    if (flag("--socket")) info.endpoint.path = flag("--socket");
    if (flag("--state")) info.state_dir = flag("--state");
    if (flag("--cache")) info.cache_dir = flag("--cache");
    process.stdout.write(JSON.stringify(info));
  }
} else {
  writeFileSync(${JSON.stringify(pid)}, String(process.pid));
  const mock = await MockWireServer.start({socketPath: flag("--socket"), model: "native-config-model", contextWindow: 65536, maxOutput: 4096});
  mock.turns.push({text: "native-config-complete"});
  process.on("SIGTERM", async () => { await mock.stop(); rmSync(mock.directory, {recursive:true, force:true}); process.exit(0); });
}
`);
  chmodSync(bin, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("XENOLITH_")) delete env[name];
  Object.assign(env, {
    HOME: root,
    XDG_RUNTIME_DIR: join(root, "default-runtime"),
    XDG_STATE_HOME: join(root, "default-state"),
    XDG_CACHE_HOME: join(root, "default-cache"),
    XDG_CONFIG_HOME: join(root, "default-config"),
    XENOLITH_BIN: bin,
    XENOPI_DIR: root,
  });
  t.after(async () => {
    if (existsSync(pid)) {
      try { process.kill(Number(readFileSync(pid, "utf8")), "SIGTERM"); } catch { /* child already exited */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const calls = (): string[][] => existsSync(trace)
    ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    : [];
  return { root, bin, env, response, data, mode, trace, calls };
}

test("native discovery starts on the configured socket without repeating inference settings", async (t) => {
  const f = fixture(t);
  const settings = resolveXenolithSettings(f.root, f.env);
  assert.equal(settings.model, undefined);
  const info = await describeService(settings);
  assert.equal(info.model, "native-config-model");
  assert.equal(info.context_window, 65536);
  const serve = f.calls().find((args) => args[0] === "serve")!;
  assert.ok(serve);
  assert.equal(serve[1], "--config");
  assert.equal(serve[serve.indexOf("--socket") + 1], f.response.endpoint.path);
  assert.equal(serve[serve.indexOf("--state") + 1], f.response.state_dir);
  assert.equal(serve[serve.indexOf("--cache") + 1], f.response.cache_dir);
  for (const flag of ["--ctx", "--mmproj", "--cache-budget", "--idle-shutdown"]) assert.equal(serve.includes(flag), false);
  await describeService(settings);
  assert.equal(f.calls().filter((args) => args[0] === "serve").length, 1);
});

test("the real CLI uses native discovery with no per-client inference config", { timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const run = execFileAsync(process.execPath, [join(packageRoot(), "dist/src/bin/xenopi.js"), "--mode", "json", "--thinking", "off", "-p", "hello"], {
    cwd: f.root, env: f.env, timeout: 15000,
  });
  run.child.stdin?.end();
  const result = await run;
  assert.match(result.stdout, /native-config-complete/);
  assert.equal(existsSync(join(f.root, "xenolith.json")), false);
  assert.equal(f.calls().filter((args) => args[0] === "serve").length, 1);
});

test("explicit client overrides go to inspect and only explicit inference overrides go to serve", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "xenolith.json"), JSON.stringify({
    config: join(f.root, "selected config.json"),
    socket: join(f.root, "custom.sock"),
    stateDir: join(f.root, "custom state"),
    cacheDir: join(f.root, "custom cache"),
    model: "/models/legacy.gguf", mmproj: "/models/projector.gguf", context: 32768,
    cacheBudget: "0", idleShutdownMinutes: 12,
  }));
  const settings = resolveXenolithSettings(f.root, { ...f.env, XENOLITH_CONTEXT: "65536" });
  const resolved = await inspectService(settings);
  const args = xenolithServiceArgs(resolved);
  assert.deepEqual(args.slice(0, 4), ["serve", "/models/legacy.gguf", "--config", join(f.root, "selected config.json")]);
  assert.equal(args[args.indexOf("--ctx") + 1], "65536");
  assert.equal(args[args.indexOf("--idle-shutdown") + 1], "12");
  assert.equal(args[args.indexOf("--mmproj") + 1], "/models/projector.gguf");
  assert.equal(args[args.indexOf("--cache-budget") + 1], "0");
  assert.equal(resolved.stateDir, join(f.root, "custom state"));
  assert.equal(resolved.socket, join(f.root, "custom.sock"));
  assert.ok(f.calls()[0]?.includes("--state"));
  assert.ok(f.calls()[0]?.includes("--cache"));
});

test("an explicit live endpoint connects without executable or native config inspection", async (t) => {
  const f = fixture(t);
  const mock = await MockWireServer.start({ model: "already-running", contextWindow: 8192 });
  t.after(async () => { await mock.stop(); rmSync(mock.directory, { recursive: true, force: true }); });
  const settings = resolveXenolithSettings(f.root, {
    ...f.env, XENOLITH_BIN: "/missing/xenolith", XENOLITH_SOCKET: mock.socketPath,
    XENOLITH_CONFIG: join(f.root, "nonexistent-config.json"), XENOLITH_NO_SPAWN: "1",
  });
  assert.equal((await describeService(settings)).model, "already-running");
  assert.deepEqual(f.calls(), []);
});

test("missing executable can connect to the conventional socket without autostart", async (t) => {
  const f = fixture(t);
  const socket = resolveXenolithSettings(f.root, f.env).socket;
  mkdirSync(dirname(socket), { recursive: true });
  const mock = await MockWireServer.start({ socketPath: socket });
  t.after(async () => { await mock.stop(); rmSync(mock.directory, { recursive: true, force: true }); });
  const settings = resolveXenolithSettings(f.root, { ...f.env, XENOLITH_BIN: "/missing/xenolith", XENOLITH_NO_SPAWN: "1" });
  assert.ok((await describeService(settings)).model);
});

test("native config errors and invalid output never become legacy fallback or spawn", async (t) => {
  const f = fixture(t);
  for (const [mode, message] of [["error", /invalid configuration/], ["invalid", /malformed JSON/], ["large", /64 KiB/]] as const) {
    writeFileSync(f.mode, mode);
    await assert.rejects(describeService(resolveXenolithSettings(f.root, { ...f.env, XENOLITH_MODEL: "/legacy.gguf" })), message);
  }
  assert.equal(f.calls().some((args) => args[0] === "serve"), false);
});

test("inspect output validates schema and operational paths while allowing future fields", (t) => {
  const f = fixture(t);
  const settings = resolveXenolithSettings(f.root, f.env);
  assert.equal(applyInspection(settings, { ...f.response, future: true }).socket, f.response.endpoint.path);
  for (const response of [
    { ...f.response, schema_version: 2 },
    { ...f.response, config_present: "yes" },
    { ...f.response, engine_lock: "relative" },
    { ...f.response, log_path: "/bad\0path" },
    { ...f.response, endpoint: { transport: "tcp", path: "/socket" } },
  ]) assert.throws(() => applyInspection(settings, response), /invalid Xenolith config inspect/);
});

test("unsupported old engine keeps explicit legacy startup but cannot ignore a selected config", async (t) => {
  const f = fixture(t);
  writeFileSync(f.mode, "old");
  const settings = resolveXenolithSettings(f.root, { ...f.env, XENOLITH_MODEL: "/legacy.gguf" });
  await describeService(settings);
  const serve = f.calls().find((args) => args[0] === "serve")!;
  assert.equal(serve[1], "/legacy.gguf");
  assert.equal(serve.includes("--config"), false);
  await assert.rejects(describeService(resolveXenolithSettings(f.root, {
    ...f.env, XENOLITH_CONFIG: join(f.root, "explicit.json"),
  })), /does not support native configuration/);
  assert.equal(f.calls().filter((args) => args[0] === "serve").length, 1);
});

test("native no-spawn resolves the socket but never starts an absent service", async (t) => {
  const f = fixture(t);
  await assert.rejects(describeService(resolveXenolithSettings(f.root, {
    ...f.env, XENOLITH_NO_SPAWN: "1",
  })), /cannot reach the xenolith wire service/);
  assert.deepEqual(f.calls().map((args) => args[0]), ["config"]);
  assert.equal(existsSync(dirname(f.response.endpoint.path)), false);
});

test("selected config and engine-state environment overrides retain their meanings", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "xenolith.json"), JSON.stringify({
    config: join(f.root, "file-config.json"), stateDir: join(f.root, "file-state"),
  }));
  const resolved = await inspectService(resolveXenolithSettings(f.root, {
    ...f.env, XENOLITH_CONFIG: join(f.root, "env-config.json"),
    XENOLITH_STATE_DIR: join(f.root, "env-engine-state"),
  }));
  assert.equal(resolved.nativeService?.configPath, join(f.root, "env-config.json"));
  assert.equal(resolved.stateDir, join(f.root, "env-engine-state"));
  assert.throws(() => resolveXenolithSettings(f.root, { ...f.env, XENOLITH_CONFIG: "relative.json" }), /absolute path/);
  assert.equal(JSON.parse(readFileSync(join(f.root, "xenolith.json"), "utf8")).stateDir, join(f.root, "file-state"));
});

test("inspect has a bounded wait and does not spawn inference after timeout", { timeout: 8000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(f.mode, "timeout");
  await assert.rejects(describeService(resolveXenolithSettings(f.root, f.env)), /timed out after 5 seconds/);
  assert.equal(f.calls().some((args) => args[0] === "serve"), false);
});
