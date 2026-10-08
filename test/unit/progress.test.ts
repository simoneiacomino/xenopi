import assert from "node:assert/strict";
import test from "node:test";
import { InferenceDisplay } from "../../src/progress.js";
import type { WireEvent } from "../../src/wire/protocol.js";

function displayHarness() {
  const lines: (string | undefined)[] = [];
  let clock = 0;
  const display = new InferenceDisplay((line) => lines.push(line), () => clock);
  return {
    display, lines,
    at(ms: number) { clock = ms; },
    event(event: WireEvent, id = 1) { display.update(id, { type: "event", event }); },
    line() { return lines.at(-1) ?? ""; },
  };
}

test("connection and startup states have elapsed time and no fictitious percentage", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  assert.match(h.line(), /Preparing prompt/);
  h.display.update(1, { type: "phase", phase: "connecting" });
  assert.match(h.line(), /Connecting to Xenolith/);
  h.display.update(1, { type: "phase", phase: "starting" });
  h.at(5200);
  h.display.update(1, { type: "event", event: { event: "progress", prefilled: -1, total: 10 } });
  assert.match(h.line(), /Starting Xenolith.*5\.2 s/);
  assert.doesNotMatch(h.line(), /%|tok\/s/);
});

test("measured prefill uses engine counts and active time rather than arrival time", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.at(9000);
  h.event({ event: "inference_progress", phase: "prefill", tokens: 512, total: 1024, elapsed_ms: 2000 });
  assert.match(h.line(), /Prefill █████░░░░░ 50% · 512\/1024 tok · 256\.0 tok\/s/);
  assert.doesNotMatch(h.line(), /≈/);
  h.at(19000);
  h.event({ event: "inference_progress", phase: "prefill", tokens: 1024, total: 1024, elapsed_ms: 4000 });
  assert.match(h.line(), /100% · 1024\/1024 tok · 256\.0 tok\/s/);
});

test("decode measurement updates while tool arguments produce no text deltas", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "decode", tokens: 20, elapsed_ms: 1000 });
  h.event({ event: "toolcall_start", id: 8, name: "read_file" });
  h.at(12000);
  h.event({ event: "inference_progress", phase: "decode", tokens: 60, elapsed_ms: 2000 });
  assert.match(h.line(), /Generating · 60 tok · 30\.0 tok\/s/);
  assert.doesNotMatch(h.line(), /≈|%/);
  h.event({ event: "toolcall_end", id: 8, name: "read_file", arguments: { path: "x" } });
  assert.match(h.line(), /60 tok · 30\.0 tok\/s/);
});

test("start preserves preparation time but starts the legacy prefill estimate", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.at(5000);
  h.display.update(1, { type: "phase", phase: "preparing" });
  h.at(15000);
  h.event({ event: "start" });
  assert.equal(h.line(), "Preparing prompt… 10.0 s");
  h.at(17000);
  h.event({ event: "progress", prefilled: 100, total: 200 });
  assert.match(h.line(), /50% · 100\/200 tok · ≈50\.0 tok\/s/);
});

test("legacy prefill estimates speed while decode only shows state and elapsed time", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "start" });
  h.at(2000);
  h.event({ event: "progress", prefilled: 100, total: 200 });
  assert.match(h.line(), /50% · 100\/200 tok · ≈50\.0 tok\/s/);
  h.event({ event: "text_delta", text: "one" });
  h.at(3000);
  h.event({ event: "reasoning_delta", text: "a much longer fragment with many words" });
  assert.equal(h.line(), "Generating · 1.0 s");
  h.event({ event: "toolcall_start", id: 1, name: "read_file" });
  assert.doesNotMatch(h.line(), /tok\/s/);
  h.event({ event: "toolcall_end", id: 1, name: "read_file", arguments: {} });
  assert.doesNotMatch(h.line(), /tok\/s/);
  h.at(4000);
  h.event({ event: "text_delta", text: "three" });
  assert.equal(h.line(), "Generating · 2.0 s");
});

test("zero prefill and full cache need no division by zero or guessed speed", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "prefill", tokens: 0, total: 0, elapsed_ms: 0 });
  assert.match(h.line(), /100% · 0\/0 tok/);
  assert.doesNotMatch(h.line(), /NaN|Infinity|tok\/s/);
  h.event({ event: "inference_progress", phase: "decode", tokens: 0, elapsed_ms: 0 });
  assert.match(h.line(), /Generating · 0 tok/);
  assert.doesNotMatch(h.line(), /%|NaN|Infinity|tok\/s/);
});

test("new generations reset measurements and reject stale events and cleanup from the old id", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "decode", tokens: 80, elapsed_ms: 1000 });
  h.display.update(2, { type: "begin" });
  assert.match(h.line(), /Preparing prompt/);
  const count = h.lines.length;
  h.event({ event: "inference_progress", phase: "decode", tokens: 999, elapsed_ms: 1000 });
  h.display.update(1, { type: "end" });
  assert.equal(h.lines.length, count);
  h.event({ event: "text_delta", text: "legacy" }, 2);
  h.at(1000);
  h.event({ event: "text_delta", text: "output" }, 2);
  assert.equal(h.line(), "Generating · 1.0 s");
  assert.doesNotMatch(h.line(), /80|999/);
});

test("terminal errors and explicit end clear the line exactly once", () => {
  for (const terminal of ["error", "end"] as const) {
    const h = displayHarness();
    h.display.update(1, { type: "begin" });
    if (terminal === "error") h.event({ event: "error", code: "io_error", error: "disconnected" });
    else h.display.update(1, { type: "end" });
    assert.equal(h.lines.at(-1), undefined);
    const count = h.lines.length;
    h.display.clear();
    h.display.update(1, { type: "end" });
    h.event({ event: "text_delta", text: "late" });
    assert.equal(h.lines.length, count);
  }
});

test("invalid or backwards counters do not corrupt the displayed rate", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "decode", tokens: 20, elapsed_ms: 1000 });
  const original = h.line();
  for (const [tokens, elapsed_ms] of [[-1, 1001], [NaN, 1001], [30, -1], [30, Infinity], [19, 2000], [21, 999]]) {
    h.event({ event: "inference_progress", phase: "decode", tokens: tokens!, elapsed_ms: elapsed_ms! });
    assert.equal(h.line(), original);
  }
});

test("an obsolete prefill sample cannot replace the current total", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "prefill", tokens: 8, total: 10, elapsed_ms: 80 });
  const original = h.line();
  h.event({ event: "inference_progress", phase: "prefill", tokens: 2, total: 100, elapsed_ms: 10 });
  assert.equal(h.line(), original);
  assert.match(h.line(), /80% · 8\/10 tok/);
});

test("an invalid phase does not claim measured capability or suppress legacy progress", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "invented", tokens: 50, elapsed_ms: 1000 } as unknown as WireEvent);
  assert.match(h.line(), /Preparing prompt/);
  h.at(2000);
  h.event({ event: "progress", prefilled: 100, total: 200 });
  assert.match(h.line(), /50% · 100\/200 tok · ≈50\.0 tok\/s/);
});

test("phase boundaries keep a local decode clock while rates use engine time", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.at(1000);
  h.event({ event: "inference_progress", phase: "prefill", state: "running", tokens: 0, total: 1024, elapsed_ms: 0 });
  assert.match(h.line(), /Prefill.*0% · 0\/1024 tok/);
  h.at(5000);
  h.event({ event: "inference_progress", phase: "prefill", state: "finished", tokens: 1024, total: 1024, elapsed_ms: 2000 });
  assert.match(h.line(), /^Preparing… 0\.0 s$/);
  h.at(6000);
  h.event({ event: "inference_progress", phase: "decode", state: "running", tokens: 0, elapsed_ms: 0 });
  h.at(9000);
  h.event({ event: "inference_progress", phase: "decode", state: "running", tokens: 40, elapsed_ms: 2000 });
  assert.match(h.line(), /40 tok · 20\.0 tok\/s · 3\.0 s$/);
  h.at(10000);
  t.mock.timers.tick(100);
  assert.match(h.line(), /20\.0 tok\/s · 4\.0 s$/);
  h.event({ event: "inference_progress", phase: "decode", state: "finished", tokens: 50, elapsed_ms: 2500 });
  assert.match(h.line(), /^Finalizing… 0\.0 s$/);
  h.at(15000);
  t.mock.timers.tick(100);
  assert.match(h.line(), /^Finalizing… 5\.0 s$/);
  // Late or duplicate data cannot reopen a closed phase or reset its successor.
  for (const event of [
    { event: "inference_progress", phase: "decode", state: "finished", tokens: 50, elapsed_ms: 2500 },
    { event: "inference_progress", phase: "decode", state: "running", tokens: 51, elapsed_ms: 2600 },
    { event: "inference_progress", phase: "prefill", state: "running", tokens: 0, total: 1024, elapsed_ms: 0 },
    { event: "text_delta", text: "late" },
    { event: "toolcall_start", id: 1, name: "read" },
  ] satisfies WireEvent[]) {
    h.event(event);
    assert.match(h.line(), /^Finalizing… 5\.0 s$/);
  }
  h.event({ event: "error", code: "io_error", error: "finalization failed" });
  assert.equal(h.lines.at(-1), undefined);
  const count = h.lines.length;
  t.mock.timers.tick(1000);
  assert.equal(h.lines.length, count);
});

test("a partial prefill finish waits without inventing a decode", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "prefill", state: "running", tokens: 0, total: 1024, elapsed_ms: 0 });
  h.event({ event: "inference_progress", phase: "prefill", state: "finished", tokens: 512, total: 1024, elapsed_ms: 1000 });
  assert.match(h.line(), /^Preparing…/);
  h.at(5000);
  h.event({ event: "text_delta", text: "unexpected" });
  assert.match(h.line(), /^Preparing… 5\.0 s$/);
  assert.doesNotMatch(h.line(), /Generating|Finalizing|100%/);
  h.display.update(1, { type: "end" });
  assert.equal(h.lines.at(-1), undefined);
});

test("fully cached prefill can open and finish immediately before decode", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "prefill", state: "running", tokens: 0, total: 0, elapsed_ms: 0 });
  h.event({ event: "inference_progress", phase: "prefill", state: "finished", tokens: 0, total: 0, elapsed_ms: 0 });
  assert.match(h.line(), /^Preparing…/);
  h.event({ event: "inference_progress", phase: "decode", state: "running", tokens: 0, elapsed_ms: 0 });
  assert.match(h.line(), /^Generating · 0 tok · 0\.0 s$/);
  assert.ok(h.lines.every((line) => !/NaN|Infinity/.test(line ?? "")));
});

test("invalid lifecycle states and obsolete finishes do not change the phase", (t) => {
  const h = displayHarness();
  t.after(() => h.display.clear());
  h.display.update(1, { type: "begin" });
  h.event({ event: "inference_progress", phase: "prefill", state: "invented", tokens: 0, total: 100, elapsed_ms: 0 } as unknown as WireEvent);
  h.at(1000);
  h.event({ event: "progress", prefilled: 10, total: 100 });
  assert.match(h.line(), /≈10\.0 tok\/s/);
  h.event({ event: "inference_progress", phase: "decode", state: "running", tokens: 20, elapsed_ms: 1000 });
  h.event({ event: "inference_progress", phase: "decode", state: "finished", tokens: 19, elapsed_ms: 999 });
  assert.match(h.line(), /^Generating · 20 tok/);
});

test("terminal events close an open lifecycle without requiring finished", (t) => {
  for (const terminal of ["error", "done", "end"] as const) {
    const h = displayHarness();
    t.after(() => h.display.clear());
    h.display.update(1, { type: "begin" });
    h.event({ event: "inference_progress", phase: "decode", state: "running", tokens: 0, elapsed_ms: 0 });
    if (terminal === "error") h.event({ event: "error", code: "io_error", error: "failed" });
    else if (terminal === "done") h.event({ event: "done", stop: "aborted", marker: null,
      usage: { input: 0, output: 0, cache_read: 0, total: 0, reasoning: 0, replayed: 0 } });
    else h.display.update(1, { type: "end" });
    assert.equal(h.lines.at(-1), undefined);
  }
});
