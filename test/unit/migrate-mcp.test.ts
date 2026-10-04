import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateMcpConfig } from "../../src/migrate-mcp.js";

test("legacy MCP configuration is backed up and converted once without losing native entries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xenopi-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "mcp.json");
  const original = JSON.stringify({
    servers: {
      local: { transport: "stdio", command: "server", args: ["arg"], cwd: "/tmp", env: { KEY: "value" }, timeoutMs: 1500 },
      remote: { transport: "http", url: "https://example.test/mcp", token: "secret", headers: { Accept: "application/json" } },
    },
    mcpServers: { existing: { command: "existing", exposure: "direct" } },
    autoEnableCodemode: false,
  });
  writeFileSync(path, original);
  assert.equal(migrateMcpConfig(dir), true);
  assert.equal(readFileSync(`${path}.pre-pi-1.0.2.bak`, "utf8"), original);
  assert.equal(statSync(`${path}.pre-pi-1.0.2.bak`).mode & 0o777, 0o600);
  const result = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(result.servers, undefined);
  assert.equal(result.autoEnableCodemode, false);
  assert.deepEqual(result.mcpServers.local, { command: "server", args: ["arg"], cwd: "/tmp", env: { KEY: "value" }, timeout: 1.5 });
  assert.deepEqual(result.mcpServers.remote, { url: "https://example.test/mcp", headers: { Accept: "application/json", Authorization: "Bearer secret" } });
  assert.equal(result.mcpServers.existing.exposure, "direct");
  assert.equal(migrateMcpConfig(dir), false);
});

test("MCP migration leaves ambiguous server names and malformed files untouched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xenopi-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "mcp.json");
  for (const original of [
    '{ broken',
    JSON.stringify({ servers: { "my-server": { transport: "stdio", command: "a" } }, mcpServers: { my_server: { command: "b" } } }),
    JSON.stringify({ servers: { bad: { transport: "sse", url: "https://example.test" } } }),
    JSON.stringify({ servers: { old: { transport: "stdio", command: "a", env: { LITERAL: "!do-not-execute" } } } }),
    JSON.stringify({ servers: { old: { transport: "http", url: "https://example.test", token: "${literal}" } } }),
  ]) {
    writeFileSync(path, original);
    assert.throws(() => migrateMcpConfig(dir));
    assert.equal(readFileSync(path, "utf8"), original);
  }
});
