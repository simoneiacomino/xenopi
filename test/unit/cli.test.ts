import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { packageRoot } from "../../src/launcher.js";
import { MockWireServer } from "./mock-wire.js";

const execFileAsync = promisify(execFile);

test("CLI cold startup creates the socket directory and exits while its engine stays running", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "xenopi-cli-cold-"));
  const pidFile = join(root, "engine.pid");
  t.after(() => {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, "fake-xenolith.mjs");
  const socket = join(root, "new-runtime", "xenolith", "wire.sock");
  const mockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "mock-wire.js")).href;
  writeFileSync(bin, `#!${process.execPath}
import { writeFileSync, rmSync } from "node:fs";
import { MockWireServer } from ${JSON.stringify(mockUrl)};
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await new Promise(resolve => setTimeout(resolve, 200));
const mock = await MockWireServer.start({socketPath: process.argv[process.argv.indexOf("--socket") + 1], contextWindow: 65536, maxOutput: 4096});
mock.turns.push({text: "startup-complete"});
process.on("SIGTERM", async () => { await mock.stop(); rmSync(mock.directory, {recursive:true, force:true}); process.exit(0); });
`);
  chmodSync(bin, 0o755);
  const run = execFileAsync(process.execPath, [join(packageRoot(), "dist/src/bin/xenopi.js"), "--mode", "json", "--thinking", "off", "-p", "hello"], {
    cwd: root,
    env: { ...process.env, XENOPI_DIR: root, XENOLITH_BIN: bin, XENOLITH_MODEL: "/fixture.gguf", XENOLITH_SOCKET: socket, XENOLITH_NO_SPAWN: "0" },
    timeout: 10000,
  });
  run.child.stdin?.end();
  const result = await run;
  assert.match(result.stdout, /startup-complete/);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  assert.doesNotThrow(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
});

for (const failure of ["exits", "missing"] as const) {
  test(`CLI startup reports an engine that ${failure} without an unsettled await`, { timeout: 15000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "xenopi-cli-startup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "fake-xenolith");
    const socket = join(root, "new-runtime", "xenolith", "wire.sock");
    if (failure === "exits") {
      writeFileSync(bin, '#!/bin/sh\necho "fixture: engine initialization failed" >&2\nexit 1\n');
      chmodSync(bin, 0o755);
    }
    await assert.rejects(() => execFileAsync(process.execPath, [join(packageRoot(), "dist/src/bin/xenopi.js"), "-p", "hello"], {
      cwd: root,
      env: { ...process.env, XENOPI_DIR: root, XENOLITH_BIN: bin, XENOLITH_MODEL: "/fixture.gguf", XENOLITH_SOCKET: socket, XENOLITH_NO_SPAWN: "0" },
      timeout: 10000,
    }), (error: unknown) => {
      const result = error as Error & { code: number; stderr: string };
      assert.equal(result.code, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /unsettled top-level await/);
      assert.match(result.stderr, failure === "exits" ? /fixture: engine initialization failed/ : /spawn failed/);
      return true;
    });
    assert.ok(existsSync(dirname(socket)), "automatic startup must create the explicit socket's parent");
  });
}

test("the actual CLI migrates MCP, discovers the model, and resumes native codemode sessions", { timeout: 30000 }, async (t) => {
  const mock = await MockWireServer.start({ model: "another-model", contextWindow: 65536 });
  const root = mkdtempSync(join(tmpdir(), "xenopi-cli-"));
  t.after(async () => { await mock.stop(); rmSync(root, { recursive: true, force: true }); rmSync(mock.directory, { recursive: true, force: true }); });
  const legacyMcp = JSON.stringify({ servers: {
    local: { transport: "stdio", command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.js")] },
  } });
  writeFileSync(join(root, "mcp.json"), legacyMcp);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultProvider: "xenolith", defaultModel: "obsolete-model" }));
  mock.turns.push(
    { calls: [{ name: "codemode", arguments: { code: 'text(await tools.mcp__local__echo({message:"cli-native"}));' } }], stop: "tool_use" },
    { text: "cli-complete" },
  );
  const packageDir = process.env["XENOPI_TEST_PACKAGE_ROOT"] ?? packageRoot();
  async function run(args: string[]): Promise<string> {
    const child = spawn(process.execPath, [join(packageDir, "dist", "src", "bin", "xenopi.js"), "--mode", "json", "--thinking", "off", ...args], {
      cwd: root,
      env: { ...process.env, XENOPI_DIR: root, XENOLITH_SOCKET: mock.socketPath, XENOLITH_NO_SPAWN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr);
    return stdout;
  }
  const stdout = await run(["-p", "Call the MCP echo tool with codemode."]);
  assert.match(stdout, /stdio:cli-native/, stdout);
  assert.match(stdout, /cli-complete/);
  assert.match(stdout, /another-model/);
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, "another-model");
  assert.equal(settings.extensions.length, 2);
  assert.ok(!settings.extensions.some((path: string) => path.endsWith("/mcp.js")));
  assert.equal(readFileSync(join(root, "mcp.json.pre-pi-1.0.2.bak"), "utf8"), legacyMcp);
  assert.ok(JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")).mcpServers.local);

  mock.turns.push(
    { calls: [{ name: "codemode", arguments: { code: 'text(await tools.mcp__local__echo({message:"cli-resumed"}));' } }], stop: "tool_use" },
    { text: "resume-complete" },
  );
  const before = mock.ops.length;
  const resumed = await run(["-c", "-p", "Repeat the MCP call after resuming."]);
  assert.match(resumed, /stdio:cli-resumed/);
  assert.match(resumed, /resume-complete/);
  assert.ok(mock.ops.slice(before).some((op) => op.op === "open"), "resume must reopen the saved wire session");
  assert.ok(!mock.ops.slice(before).some((op) => op.op === "create"), "resume must preserve the wire binding");
});
