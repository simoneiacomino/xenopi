import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  connectServer,
  loadSessions,
  normalizeSchema,
  qualifiedName,
  readMcpConfig,
  schemaOf,
  toolDefinitions,
  type McpConfig,
} from "../../src/extensions/mcp.js";
import xenopiMcp from "../../src/extensions/mcp.js";
import { startHttpFixture } from "./fixtures/mcp-http-server.js";
import { ECHO_SCHEMA, PYDANTIC_SCHEMA } from "./fixtures/mcp-tools.js";

const TOKEN = "s3cr3t-token";
const here = dirname(fileURLToPath(import.meta.url));
const stdioEntry = join(here, "fixtures", "mcp-stdio-server.js");

function agentDirWith(config: McpConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "xenopi-mcp-"));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(config, null, 2));
  return dir;
}

test("a stdio MCP server's tools are listed and callable", async (t) => {
  const session = await connectServer("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: [stdioEntry],
  });
  t.after(() => session.client.close());

  const names = session.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["boom", "echo", "search"]);

  const definitions = toolDefinitions(session);
  const echo = definitions.find((tool) => tool.name === qualifiedName("fixture", "echo"));
  assert.ok(echo);
  assert.deepEqual(echo.parameters as unknown, {
    type: "object",
    properties: { message: { type: "string", description: "The message to echo back." } },
    required: ["message"],
  });

  const result = await echo.execute("call-1", { message: "hello" }, undefined, undefined, {} as never);
  assert.deepEqual(result.content, [{ type: "text", text: "stdio:hello" }]);

  const search = definitions.find((tool) => tool.name === qualifiedName("fixture", "search"));
  assert.ok(search);
  const rendered = JSON.stringify(search.parameters);
  assert.equal(rendered.includes("$ref"), false);
  assert.equal(rendered.includes("$defs"), false);
  assert.equal(rendered.includes("anyOf"), false);
  const params = search.parameters as unknown as Record<string, unknown>;
  for (const value of Object.values(params["properties"] as Record<string, Record<string, unknown>>)) {
    assert.equal(typeof value["type"], "string");
  }
});

test("an MCP tool error becomes a thrown execution failure", async (t) => {
  const session = await connectServer("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: [stdioEntry],
  });
  t.after(() => session.client.close());

  const boom = toolDefinitions(session).find((tool) => tool.name === qualifiedName("fixture", "boom"));
  assert.ok(boom);
  await assert.rejects(
    () => boom.execute("call-2", {}, undefined, undefined, {} as never),
    /boom failed/,
  );
});

test("streamable HTTP rejects a wrong bearer token and accepts the right one", async (t) => {
  const fixture = await startHttpFixture(TOKEN);
  t.after(() => fixture.close());

  await assert.rejects(
    () => connectServer("remote", { transport: "http", url: fixture.url, token: "wrong-token" }),
    /401|Unauthorized|unauthorized/i,
  );
  assert.ok(fixture.rejected > 0);

  const session = await connectServer("remote", { transport: "http", url: fixture.url, token: TOKEN });
  t.after(() => session.client.close());

  assert.deepEqual(session.tools.map((tool) => tool.name).sort(), ["boom", "echo", "search"]);
  const echo = toolDefinitions(session).find((tool) => tool.name === qualifiedName("remote", "echo"));
  assert.ok(echo);
  const result = await echo.execute("call-3", { message: "over http" }, undefined, undefined, {} as never);
  assert.deepEqual(result.content, [{ type: "text", text: "http:over http" }]);
});

test("the extension registers both transports' tools from mcp.json", async (t) => {
  const fixture = await startHttpFixture(TOKEN);
  t.after(() => fixture.close());
  const agentDir = agentDirWith({
    servers: {
      local: { transport: "stdio", command: process.execPath, args: [stdioEntry] },
      remote: { transport: "http", url: fixture.url, token: TOKEN },
    },
  });
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const registered: ToolDefinition[] = [];
  const shutdown: (() => void)[] = [];
  const pi = {
    registerTool(tool: ToolDefinition): void {
      registered.push(tool);
    },
    on(_event: string, handler: () => void): void {
      shutdown.push(handler);
    },
  } as unknown as ExtensionAPI;

  try {
    await xenopiMcp(pi);
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
  }

  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "local__boom",
    "local__echo",
    "local__search",
    "remote__boom",
    "remote__echo",
    "remote__search",
  ]);
  const remoteEcho = registered.find((tool) => tool.name === "remote__echo");
  assert.ok(remoteEcho);
  const result = await remoteEcho.execute("call-4", { message: "wired" }, undefined, undefined, {} as never);
  assert.deepEqual(result.content, [{ type: "text", text: "http:wired" }]);
  for (const handler of shutdown) handler();
});

test("an unreachable server is skipped without failing the others", async (t) => {
  const agentDir = agentDirWith({
    servers: {
      broken: { transport: "http", url: "http://127.0.0.1:1/mcp", token: "x" },
      local: { transport: "stdio", command: process.execPath, args: [stdioEntry] },
    },
  });
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const sessions = await loadSessions(agentDir);
  t.after(() => Promise.all(sessions.map((session) => session.client.close())));

  assert.deepEqual(sessions.map((session) => session.server), ["local"]);
});

test("schema normalization keeps profile-renderable members and defaults to an object", () => {
  assert.deepEqual(schemaOf({ name: "echo", inputSchema: ECHO_SCHEMA }, () => undefined) as unknown, {
    type: "object",
    properties: { message: { type: "string", description: "The message to echo back." } },
    required: ["message"],
  });
  assert.deepEqual(schemaOf({ name: "bare" }, () => undefined) as unknown, {
    type: "object",
    properties: {},
  });
});

test("a pydantic-shaped schema is inlined, collapsed and pruned to what the profile renders", () => {
  const { schema, dropped } = normalizeSchema(PYDANTIC_SCHEMA);

  assert.equal(schema["type"], "object");
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties["query"], { type: "string", description: "Search text." });
  assert.deepEqual(properties["limit"], { type: "integer", nullable: true });
  assert.deepEqual(properties["priority"], { type: "string", enum: ["low", "high"] });
  assert.deepEqual(properties["filters"], {
    type: "array",
    nullable: true,
    items: {
      type: "object",
      properties: {
        field: { type: "string" },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["field"],
    },
  });
  assert.deepEqual(properties["mode"], { type: "string", enum: ["fast"] });
  assert.equal(properties["freeform"], undefined);
  assert.deepEqual(dropped, ["/freeform"]);
  assert.deepEqual(schema["required"], ["query", "priority"]);
  assert.equal(JSON.stringify(schema).includes("$ref"), false);
  assert.equal(JSON.stringify(schema).includes("$defs"), false);
  assert.equal(JSON.stringify(schema).includes("anyOf"), false);
});

test("every normalized property carries a plain string type the profile accepts", () => {
  const { schema } = normalizeSchema(PYDANTIC_SCHEMA);
  const renderable = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
  const walk = (node: Record<string, unknown>): void => {
    assert.equal(typeof node["type"], "string");
    assert.equal(renderable.has(node["type"] as string), true);
    const properties = node["properties"];
    if (properties && typeof properties === "object") {
      for (const value of Object.values(properties as Record<string, unknown>)) {
        walk(value as Record<string, unknown>);
      }
    }
    const items = node["items"];
    if (items && typeof items === "object") walk(items as Record<string, unknown>);
  };
  walk(schema);
});

test("a schema with a broken $ref degrades to an object instead of failing the session", () => {
  const { schema, dropped } = normalizeSchema({
    type: "object",
    properties: { broken: { $ref: "#/$defs/Missing" } },
    required: ["broken"],
  });

  assert.deepEqual(schema, { type: "object", properties: {} });
  assert.deepEqual(dropped, ["/broken"]);
});

test("a pydantic tool call round-trips through the normalized schema", async (t) => {
  const session = await connectServer("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: [stdioEntry],
  });
  t.after(() => session.client.close());

  const search = toolDefinitions(session).find((tool) => tool.name === qualifiedName("fixture", "search"));
  assert.ok(search);
  const result = await search.execute(
    "call-5",
    { query: "wire", priority: "high" },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ query: "wire", priority: "high" }) }]);
});

test("a missing or malformed mcp.json yields no servers", () => {
  const empty = mkdtempSync(join(tmpdir(), "xenopi-mcp-empty-"));
  try {
    assert.deepEqual(readMcpConfig(empty), {});
    writeFileSync(join(empty, "mcp.json"), "{ not json");
    assert.deepEqual(readMcpConfig(empty), {});
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
