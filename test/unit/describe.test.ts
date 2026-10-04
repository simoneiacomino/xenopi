import assert from "node:assert/strict";
import test from "node:test";
import { parseDescription } from "../../src/wire/describe.js";
import { providerModel } from "../../src/extensions/provider.js";

const description = {
  protocol: 1, model: "future-model", context_window: 32768, max_output: 4096,
  max_frame: 524288, kvstore: false,
  reasoning: { efforts: ["low", "high"], history: ["discard"], budget_tokens: false },
};

test("model registration reflects service capabilities instead of a model family", () => {
  const model = providerModel(parseDescription(description));
  assert.equal(model.id, "future-model");
  assert.equal(model.contextWindow, 32768);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
  assert.deepEqual(model.input, ["text"]);
  assert.equal(providerModel(parseDescription({ ...description, reasoning: { ...description.reasoning, efforts: [] } })).reasoning, false);
});

test("unsupported protocols and malformed capabilities fail before registration", () => {
  for (const patch of [
    { protocol: 2 }, { model: "" }, { context_window: 0 }, { max_output: -1 },
    { max_frame: Number.NaN }, { reasoning: { efforts: ["magic"] } },
  ]) assert.throws(() => parseDescription({ ...description, ...patch }), /describe response/);
});
