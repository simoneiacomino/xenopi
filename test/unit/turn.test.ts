import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { TurnBuilder } from "../../src/adapter/turn.js";
import { harness, model, user } from "./harness.js";

const usage = { input: 1, output: 1, cache_read: 0, reasoning: 0, replayed: 0, total: 2 };

test("tool start exposes its identity before arguments arrive and end updates the same index", async () => {
  const stream = createAssistantMessageEventStream();
  const builder = new TurnBuilder(stream, model);
  const events = stream[Symbol.asyncIterator]();
  builder.toolCallStart(7, "probe");
  const start = (await events.next()).value;
  assert.ok(start?.type === "toolcall_start");
  assert.deepEqual(start.partial.content[start.contentIndex], {
    type: "toolCall", id: "7", name: "probe", arguments: {},
  });

  builder.toolCallEnd(7, "probe", { value: "complete" });
  const end = (await events.next()).value;
  assert.ok(end?.type === "toolcall_end");
  assert.equal(end.contentIndex, start.contentIndex);
  assert.equal(end.partial.content.length, 1);
  assert.deepEqual(end.toolCall.arguments, { value: "complete" });
  builder.done("tool_use", usage);
});

for (const stop of ["stop", "tool_use", "length", "aborted", "error"] as const) {
  test(`${stop} discards unfinished calls while preserving text and completed calls`, async () => {
    const stream = createAssistantMessageEventStream();
    const builder = new TurnBuilder(stream, model);
    builder.toolCallStart(1, "unfinished");
    builder.textDelta("preserved");
    builder.toolCallStart(2, "complete");
    builder.toolCallEnd(2, "complete", { value: "kept" });
    builder.toolCallStart(3, "also_unfinished");
    if (stop === "error" || stop === "aborted") builder.fail(stop, "interrupted", usage);
    else builder.done(stop, usage);

    const result = await stream.result();
    assert.deepEqual(result.content, [
      { type: "text", text: "preserved" },
      { type: "toolCall", id: "2", name: "complete", arguments: { value: "kept" } },
    ]);
    assert.deepEqual(builder.wireMessage.calls, [{ name: "complete", arguments: { value: "kept" } }]);
    assert.deepEqual(builder.wireCallIds, [2]);
    // Consumers may still have queued start/end events when generation finishes.
    for await (const event of stream) {
      if (event.type === "toolcall_start" || event.type === "toolcall_end") {
        assert.equal(event.partial.content[event.contentIndex]?.type, "toolCall");
      } else if (event.type === "text_end") {
        assert.deepEqual(event.partial.content[event.contentIndex], { type: "text", text: "preserved" });
      }
    }
  });
}

for (const stop of ["stop", "tool_use"] as const) {
  test(`Pi never executes a wire call missing its end event on ${stop}`, async (t) => {
    const h = await harness();
    t.after(() => h.dispose());
    let executions = 0;
    const tool = {
      name: "probe", label: "Probe", description: "Count executions",
      parameters: Type.Object({}),
      async execute() {
        executions++;
        return { content: [{ type: "text" as const, text: "counted" }], details: {} };
      },
    };
    // Xenolith can emit EOS after CALL_START and discard the unfinished call.
    h.mock.turns.push({
      finalProgressEvents: [{ event: "toolcall_start", id: 42, name: "probe" }],
      stop,
    });
    const messages = await runAgentLoop(
      [user("test incomplete call")],
      { messages: [], tools: [tool] },
      {
        model,
        convertToLlm: (messages) => messages.filter((message) =>
          message.role === "system" || message.role === "user" ||
          message.role === "assistant" || message.role === "toolResult"),
        finishTurn: () => ({ action: "end" }),
      },
      () => {}, undefined,
      (model, context, options) => h.adapter.streamSimple(model, context, options),
    );
    assert.equal(executions, 0);
    assert.ok(!messages.some((message) => message.role === "toolResult"));
  });
}
