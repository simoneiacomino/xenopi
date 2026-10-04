import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeSession } from "./native-session.js";
import { startHttpFixture } from "./fixtures/mcp-http-server.js";
import { PYDANTIC_SCHEMA } from "./fixtures/mcp-tools.js";

const stdio = { command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.js")] };

test("native MCP stdio direct calls cross the Pi agent loop and preserve JSON schemas", async (t) => {
  const h = await nativeSession({ local: { ...stdio, exposure: "direct" } });
  t.after(() => h.close());
  h.mock.turns.push(
    { calls: [{ name: "mcp__local__search", arguments: { query: "wire", priority: "high", freeform: { arbitrary: true } } }], stop: "tool_use" },
    { text: "done" },
  );
  await h.session.prompt("Search using MCP.");
  const results = h.session.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, false);
  assert.match(JSON.stringify(results[0]!.content), /arbitrary/);
  const create = h.mock.ops.find((op) => op.op === "create")!;
  const tools = create.tools as { name: string; parameters: unknown }[];
  assert.deepEqual(tools.find((tool) => tool.name === "mcp__local__search")!.parameters, PYDANTIC_SCHEMA);
  const before = h.mock.ops.length;
  h.mock.turns.push({ text: "next" });
  await h.session.prompt("Continue.");
  assert.deepEqual(h.mock.ops.slice(before).map((op) => op.op), ["append", "generate"]);
});

test("native MCP HTTP uses the bearer header and reports tool errors", async (t) => {
  const http = await startHttpFixture("fixture-token");
  const h = await nativeSession({
    remote: { url: http.url, headers: { Authorization: "Bearer fixture-token" }, exposure: "direct" },
    rejected: { url: http.url, headers: { Authorization: "Bearer wrong-token" }, exposure: "direct" },
  });
  t.after(async () => { await h.close(); await http.close(); });
  h.mock.turns.push(
    { calls: [{ name: "mcp__remote__echo", arguments: { message: "native" } }], stop: "tool_use" },
    { calls: [{ name: "mcp__remote__boom", arguments: {} }], stop: "tool_use" },
    { text: "done" },
  );
  await h.session.prompt("Call the HTTP tools.");
  assert.ok(http.rejected > 0, "invalid credentials must be rejected without breaking the working server");
  const results = h.session.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.match(JSON.stringify(results[0]!.content), /http:native/);
  assert.equal(results[1]!.isError, true);
  assert.match(JSON.stringify(results[1]!.content), /boom failed/);
});

test("native codemode calls MCP tools and keeps their declarations out of the wire prompt", async (t) => {
  const h = await nativeSession({ local: stdio });
  t.after(() => h.close());
  h.mock.turns.push(
    { calls: [{ name: "codemode", arguments: { code: 'const r = await tools.mcp__local__echo({message:"codemode"}); text(r);' } }], stop: "tool_use" },
    { text: "done" },
  );
  await h.session.prompt("Use codemode to call the local echo tool.");
  const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.match(JSON.stringify(result.content), /stdio:codemode/);
  const create = h.mock.ops.find((op) => op.op === "create")!;
  const tools = create.tools as { name: string }[];
  assert.ok(tools.some((tool) => tool.name === "codemode"));
  assert.ok(!tools.some((tool) => tool.name === "mcp__local__echo"));
  await h.session.reload();
  h.mock.turns.push(
    { calls: [{ name: "codemode", arguments: { code: 'text(await tools.mcp__local__echo({message:"after-reload"}));' } }], stop: "tool_use" },
    { text: "done" },
  );
  await h.session.prompt("Repeat after reload.");
  assert.match(JSON.stringify(h.session.messages), /stdio:after-reload/);
});

test("native deferred tool search loads an MCP tool for the following turn", async (t) => {
  const h = await nativeSession({ local: { ...stdio, exposure: "deferred" } });
  t.after(() => h.close());
  h.mock.turns.push(
    { calls: [{ name: "tool_search", arguments: { query: "echo" } }], stop: "tool_use" },
    { calls: [{ name: "mcp__local__echo", arguments: { message: "discovered" } }], stop: "tool_use" },
    { text: "done" },
  );
  await h.session.prompt("Find and call the echo tool.");
  assert.match(JSON.stringify(h.session.messages), /stdio:discovered/);
  assert.ok(h.mock.ops.some((op) => op.op === "rebuild"), "changed tool declarations must rebuild the v1 context");
});
