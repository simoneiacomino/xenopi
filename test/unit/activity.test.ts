import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ActivityUpdate, ConnectionPhase } from "../../src/activity.js";
import { InferenceDisplay } from "../../src/progress.js";
import { XenolithAdapter } from "../../src/adapter/adapter.js";
import { openConnection } from "../../src/wire/client.js";
import type { WireEvent } from "../../src/wire/protocol.js";
import { collect, context, harness, settingsFor, user } from "./harness.js";

test("connection status distinguishes an existing service from a failed engine startup", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const phases: ConnectionPhase[] = [];
  const connection = await openConnection({ settings: settingsFor(h.mock.socketPath), onStatus: (phase) => phases.push(phase) });
  connection.close();
  assert.deepEqual(phases, ["connecting", "ready"]);

  const directory = mkdtempSync(join(tmpdir(), "xenopi-start-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "fake-engine");
  writeFileSync(bin, "#!/bin/sh\nexit 1\n");
  chmodSync(bin, 0o755);
  phases.length = 0;
  await assert.rejects(openConnection({
    settings: { ...settingsFor(join(directory, "wire.sock")), spawn: true, bin, model: "/fake.gguf" },
    attempts: 2, baseDelayMs: 20, onStatus: (phase) => phases.push(phase),
  }), /cannot reach/);
  assert.deepEqual(phases, ["connecting", "starting"]);
});

test("a fresh connection failure clears preparation before any wire start event", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xenopi-connect-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = new XenolithAdapter({
    agentDir: directory,
    settings: settingsFor(join(directory, "missing.sock")),
    log: () => undefined,
  });
  t.after(() => adapter.close());
  const updates: ActivityUpdate[] = [];
  const lines: (string | undefined)[] = [];
  const display = new InferenceDisplay((line) => lines.push(line));
  t.after(() => display.clear());
  adapter.setActivitySink((id, update) => { updates.push(update); display.update(id, update); });
  const result = await collect(adapter, context([user("hello")]));
  await setImmediate();
  assert.equal(result.message.stopReason, "error");
  assert.match(result.message.errorMessage ?? "", /cannot reach/);
  assert.equal(updates[0]?.type, "begin");
  assert.ok(updates.some((update) => update.type === "phase" && update.phase === "connecting"));
  assert.equal(updates.some((update) => update.type === "event"), false);
  assert.equal(updates.at(-1)?.type, "end");
  assert.equal(lines.at(-1), undefined);
});

test("adapter forwards raw measured telemetry and updates tool progress without changing Pi content", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const progress: WireEvent[] = [
    { event: "inference_progress", phase: "prefill", tokens: 512, total: 1024, elapsed_ms: 2000 },
    { event: "inference_progress", phase: "decode", tokens: 5, elapsed_ms: 500 },
  ];
  const toolProgress: WireEvent = { event: "inference_progress", phase: "decode", tokens: 20, elapsed_ms: 1000 };
  h.mock.turns.push({ text: "checking", calls: [{ name: "read_file", arguments: { path: "x" } }], stop: "tool_use", progressEvents: progress, toolProgressEvents: [toolProgress] });
  const updates: { id: number; update: ActivityUpdate }[] = [];
  const lines: (string | undefined)[] = [];
  const display = new InferenceDisplay((line) => lines.push(line));
  t.after(() => display.clear());
  h.adapter.setActivitySink((id, update) => { updates.push({ id, update }); display.update(id, update); });
  const raw: unknown[] = [];
  const result = await collect(h.adapter, context([user("read")]), { onProviderStreamEvent: (event) => { raw.push(event); } });
  await setImmediate();
  assert.equal(result.message.stopReason, "toolUse");
  assert.deepEqual(raw.filter((event) => (event as WireEvent).event === "inference_progress"), [...progress, toolProgress]);
  assert.equal(updates[0]?.update.type, "begin");
  assert.equal(updates.at(-1)?.update.type, "end");
  assert.equal(new Set(updates.map(({ id }) => id)).size, 1);
  assert.ok(lines.some((line) => line?.includes("512/1024 tok · 256.0 tok/s")));
  assert.ok(lines.some((line) => line?.includes("20 tok · 20.0 tok/s")));
  assert.equal(lines.at(-1), undefined);
  assert.deepEqual(result.message.content, [
    { type: "text", text: "checking" },
    { type: "toolCall", id: "1", name: "read_file", arguments: { path: "x" } },
  ]);
});

for (const scenario of ["rejected", "wire-error", "cancelled", "disconnected"] as const) {
  test(`adapter clears activity after a ${scenario} generation`, async (t) => {
    const h = await harness();
    t.after(() => h.dispose());
    const updates: ActivityUpdate[] = [];
    const lines: (string | undefined)[] = [];
    const display = new InferenceDisplay((line) => lines.push(line));
    t.after(() => display.clear());
    h.adapter.setActivitySink((id, update) => { updates.push(update); display.update(id, update); });
    const controller = new AbortController();
    if (scenario === "rejected") h.mock.turns.push({ reject: { code: "invalid_request", error: "invalid generation" } });
    else if (scenario === "wire-error") h.mock.turns.push({ error: { code: "io_error", error: "generation failed" } });
    else h.mock.turns.push({ text: "abcdef", chunk: 1, delayMs: 5 });
    const result = await collect(h.adapter, context([user("go")]), {
      sessionId: "0199cccc-dddd-7eee-8fff-000011112222",
      signal: controller.signal,
      onProviderStreamEvent: (raw) => {
        const event = raw as WireEvent;
        if (event.event === "text_delta") {
          if (scenario === "cancelled") controller.abort();
          if (scenario === "disconnected") h.adapter.close();
        }
      },
    });
    await setImmediate();
    assert.equal(result.message.stopReason, scenario === "cancelled" ? "aborted" : "error");
    assert.equal(updates[0]?.type, "begin");
    assert.equal(updates.at(-1)?.type, "end");
    assert.equal(updates.filter((update) => update.type === "end").length, 1);
    assert.equal(lines.at(-1), undefined);
  });
}

test("legacy streams retain progress forwarding and activity ids reset between generations", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const updates: { id: number; update: ActivityUpdate }[] = [];
  h.adapter.setActivitySink((id, update) => updates.push({ id, update }));
  const legacy: WireEvent = { event: "progress", prefilled: 50, total: 100 };
  h.mock.turns.push({ text: "one", progressEvents: [legacy] }, { text: "two" });
  const raw: unknown[] = [];
  await collect(h.adapter, context([user("one")]), { onProviderStreamEvent: (event) => { raw.push(event); } });
  await setImmediate();
  await collect(h.adapter, context([user("two")]));
  await setImmediate();
  assert.ok(raw.some((event) => JSON.stringify(event) === JSON.stringify(legacy)));
  const begins = updates.filter(({ update }) => update.type === "begin");
  const ends = updates.filter(({ update }) => update.type === "end");
  assert.equal(begins.length, 2);
  assert.deepEqual(ends.map(({ id }) => id), begins.map(({ id }) => id));
  assert.notEqual(begins[0]?.id, begins[1]?.id);
});
