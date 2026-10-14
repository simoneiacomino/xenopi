import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import { XenolithAdapter, fromHistory } from "../../src/adapter/adapter.js";
import { keyOf, translateContext } from "../../src/adapter/translate.js";
import { resolveXenolithSettings } from "../../src/config.js";
import { providerModel } from "../../src/extensions/provider.js";
import { InferenceDisplay } from "../../src/progress.js";
import { appendRequest, openConnection, xenolithServiceArgs, type WireConnection } from "../../src/wire/client.js";
import { parseDescription } from "../../src/wire/describe.js";
import { decodeImageData, readImageMedia } from "../../src/wire/images.js";
import type { WireHistoryEntry, WireHistoryImage } from "../../src/wire/protocol.js";
import { collect, context, harness, settingsFor, user } from "./harness.js";
import { nativeSession } from "./native-session.js";
import { photo, png, vision } from "./vision-fixture.js";

const SESSION = "vision-session";
const hash = (data: string) => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
const description = { protocol: 2, model: "test-model", context_window: 65536, max_output: 65536,
  max_frame: 96 * 1024 * 1024, kvstore: true, vision,
  reasoning: { efforts: [], history: ["discard"], budget_tokens: false } };

test("vision settings use the existing projector only when spawning", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xenopi-vision-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "xenolith.json"), JSON.stringify({ model: "/model.gguf", mmproj: "/existing/mmproj-F16.gguf", imageBudget: 140 }));
  const settings = resolveXenolithSettings(root, {});
  assert.equal(settings.imageBudget, 140);
  assert.ok(xenolithServiceArgs(settings).includes("/existing/mmproj-F16.gguf"));
  assert.equal(xenolithServiceArgs(settings).includes("--image-budget"), false);
  assert.equal(resolveXenolithSettings(root, { XENOLITH_MMPROJ: "/override.gguf", XENOLITH_IMAGE_BUDGET: "1120" }).mmproj, "/override.gguf");
  for (const value of ["-1", "0", "NaN", "1.5", ""]) assert.throws(() => resolveXenolithSettings(root, { XENOLITH_IMAGE_BUDGET: value }), /imageBudget/);
});

test("v2 discovers vision without advertising image support on v1", () => {
  const info = parseDescription(description);
  assert.deepEqual(providerModel(info).input, ["text", "image"]);
  assert.equal(providerModel(info).inputLimits?.images?.maxPerMessage, 1);
  assert.deepEqual(providerModel(parseDescription({ ...description, protocol: 1, vision: undefined })).input, ["text"]);
  for (const patch of [{ default_budget: 1 }, { budgets: [] }, { budgets: [NaN] }, { formats: ["webp"] },
    { max_bytes: -1 }, { max_context_media_bytes: 1 }, { media_refs: "yes" }]) {
    assert.throws(() => parseDescription({ ...description, vision: { ...vision, ...patch } }), /vision/);
  }
});

test("wire image keys bind original bytes and budget, and match history references", () => {
  const input = translateContext(context([photo()])).messages[0]!;
  const entry: WireHistoryEntry = { kind: "user", marker: 1, text: input.message.text!,
    image: { id: hash(png), bytes: Buffer.from(png, "base64").length, budget: 280, rows: 256 } };
  assert.equal(input.key, keyOf(fromHistory(entry).message));
  assert.notEqual(input.key, keyOf({ ...input.message, image: { data: png, budget: 140 } }));
  assert.notEqual(input.key, keyOf({ ...input.message, image: { data: png.slice(0, -4) + "AAAA", budget: 280 } }));
  assert.equal(input.key.includes(png), false);
  assert.deepEqual(appendRequest(input.message).image, { data: png, budget: 280 });
});

test("invalid image data, MIME types and multiple images fail explicitly", () => {
  for (const data of ["", png + "\n", png.replace("+", "-"), "a===", "AAAA="]) {
    if (data === png) continue;
    assert.throws(() => translateContext(context([photo("caption", data)])), /Base64/);
  }
  const image = { type: "image" as const, data: png, mimeType: "image/png" };
  assert.throws(() => translateContext(context([{ role: "user", content: [image, image], timestamp: 0 }])), /one image/);
  assert.throws(() => translateContext(context([{ role: "user", content: [{ ...image, mimeType: "image/jpeg" }], timestamp: 0 }])), /MIME/);
  assert.throws(() => decodeImageData(png, 1), /size limit/);
  assert.throws(() => fromHistory({ kind: "user", text: "", marker: 1, image: { id: "bad", bytes: 1, budget: 70, rows: 1 } }), /metadata/);
});

test("v1 refuses an image before creating or changing a wire conversation", async (t) => {
  const h = await harness(); t.after(() => h.dispose());
  const result = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(result.message.stopReason, "error");
  assert.match(result.message.errorMessage!, /text only/);
  assert.deepEqual(h.mock.opNames(), ["describe"]);
});

test("image turns append once and reconcile after restart without duplicating images", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  const first = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(first.message.stopReason, "stop");
  assert.deepEqual(h.mock.ops.find((op) => op.op === "append")?.image, { data: png, budget: 280 });
  h.adapter.close(); h.mock.reset();
  const next = await collect(h.newAdapter(), context([photo(), first.message, user("What color is it?")]), { sessionId: SESSION });
  assert.equal(next.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
  assert.equal(h.mock.ops.find((op) => op.op === "append")?.image, undefined);
});

test("rebuild and fork preserve images; existing media references stay conversation-scoped", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  const first = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  h.mock.reset();
  const rebuilt = await collect(h.adapter, context([photo(), first.message, user("continue")], "changed system"), { sessionId: SESSION });
  assert.equal(rebuilt.message.stopReason, "stop");
  const rebuiltMessages = h.mock.ops.find((op) => op.op === "rebuild")?.messages as { image?: unknown }[];
  assert.deepEqual(rebuiltMessages[0]?.image, { id: hash(png), budget: 280 });
  h.mock.reset();
  const forked = await collect(h.adapter, context([photo(), first.message, user("fork")]), { sessionId: "another-session" });
  assert.equal(forked.message.stopReason, "stop");
  const forkMessages = h.mock.ops.find((op) => op.op === "rebuild")?.messages as { image?: unknown }[];
  assert.deepEqual(h.mock.ops.find((op) => op.op === "append")?.image, { data: png, budget: 280 });
  assert.deepEqual(forkMessages[0]?.image, { id: hash(png), budget: 280 });
});

test("changing image bytes invalidates the old visual prefix", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  h.mock.reset();
  const changed = png.slice(0, -4) + "AAAA";
  const result = await collect(h.adapter, context([photo("What is in this image?", changed)]), { sessionId: SESSION });
  assert.equal(result.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
  assert.deepEqual((h.mock.ops[0]?.messages as { image?: unknown }[])[0]?.image, { data: changed, budget: 280 });
});

test("the configured budget is validated against the service and participates in restart keys", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  const adapter = new XenolithAdapter({ agentDir: h.agentDir, settings: { ...settingsFor(h.mock.socketPath), imageBudget: 1120 } });
  t.after(() => adapter.close());
  const first = await collect(adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(first.message.stopReason, "stop");
  assert.equal((h.mock.ops.find((op) => op.op === "append")?.image as { budget: number }).budget, 1120);
  adapter.close(); h.mock.reset();
  await collect(h.newAdapter(), context([photo(), first.message, user("continue")]), { sessionId: SESSION });
  assert.ok(h.mock.opNames().includes("rebuild"));
  const invalid = new XenolithAdapter({ agentDir: h.agentDir, settings: { ...settingsFor(h.mock.socketPath), imageBudget: 123 } });
  t.after(() => invalid.close()); h.mock.reset();
  const result = await collect(invalid, context([photo()]), { sessionId: "invalid-budget" });
  assert.match(result.message.errorMessage!, /image budget/);
  assert.deepEqual(h.mock.opNames(), ["describe"]);
});

test("ephemeral summaries and tool-result images are forwarded", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  const ephemeral = await collect(h.adapter, context([photo()]));
  assert.equal(ephemeral.message.stopReason, "stop");
  assert.deepEqual((h.mock.ops.find((op) => op.op === "ephemeral")?.messages as { image?: unknown }[])[0]?.image, { data: png, budget: 280 });
  h.mock.turns.push({ calls: [{ name: "screenshot", arguments: {} }], stop: "tool_use" });
  const tools = [{ name: "screenshot", description: "Take screenshot", parameters: Type.Object({}) }];
  const first = await collect(h.adapter, context([user("Look at my screen")], "S", tools), { sessionId: SESSION });
  const call = first.message.content.find((c) => c.type === "toolCall")!;
  assert.equal(call.type, "toolCall");
  const result: Message = { role: "toolResult", toolName: "screenshot", toolCallId: call.id, isError: false,
    content: [{ type: "image", data: png, mimeType: "image/png" }, { type: "text", text: "dimension hint" }], timestamp: 0 };
  h.mock.reset();
  await collect(h.adapter, context([user("Look at my screen"), first.message, result], "S", tools), { sessionId: SESSION });
  const appended = h.mock.ops.find((op) => op.op === "append")!;
  assert.equal(appended.role, "tool"); assert.equal(appended.call_id, 1);
  assert.equal(appended.text, "dimension hint");
  assert.deepEqual(appended.image, { data: png, budget: 280 });
});

test("image preparation has an honest waiting phase and cancellation never launches generation", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  let release!: () => void; let entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.mock.imagePreparation = async () => { entered(); await wait; };
  const lines: (string | undefined)[] = [];
  const display = new InferenceDisplay((line) => lines.push(line)); t.after(() => display.clear());
  h.adapter.setActivitySink(display.update);
  const controller = new AbortController();
  const pending = collect(h.adapter, context([photo()]), { sessionId: SESSION, signal: controller.signal });
  await started;
  assert.ok(lines.some((line) => line?.startsWith("Preparing image…")));
  assert.equal(lines.some((line) => line?.includes("tok/s") || line?.includes("%")), false);
  controller.abort(); release();
  const result = await pending;
  assert.equal(result.message.stopReason, "aborted");
  assert.equal(h.mock.opNames().includes("generate"), false);
  assert.equal(h.adapter.liveSession(SESSION)?.dirty, true);
  assert.equal(lines.at(-1), undefined);
  h.mock.imagePreparation = undefined; h.mock.reset();
  const after = await collect(h.adapter, context([photo(), user("continue")]), { sessionId: SESSION });
  assert.equal(after.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
});

test("failed image preparation is not retried as an expensive rebuild", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  h.mock.imageFailure = "image decode failed";
  const result = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(result.message.stopReason, "error");
  assert.deepEqual(h.mock.opNames(), ["describe", "create", "append"]);
});

test("an unknown image append outcome is reconciled after disconnect, never blindly appended again", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  h.mock.dropAfterImageAppend = true;
  const failed = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(failed.message.stopReason, "error"); h.mock.reset();
  const recovered = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(recovered.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "generate"]);
});

test("inline and context media limits fail before mutating the conversation", async (t) => {
  const h = await harness({ vision: { ...vision, max_bytes: 10, max_context_media_bytes: 10 } }); t.after(() => h.dispose());
  const oversized = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  assert.equal(oversized.message.stopReason, "error"); assert.deepEqual(h.mock.opNames(), ["describe"]);
});

test("media retrieval checks chunk offsets, total size and SHA-256", async (t) => {
  const h = await harness({ vision, maxLine: 4096 }); t.after(() => h.dispose());
  const connection = await openConnection({ settings: settingsFor(h.mock.socketPath) }); t.after(() => connection.close());
  connection.maxFrameBytes = 4096;
  await connection.request({ op: "create" });
  await connection.request({ op: "append", role: "user", text: "", image: { data: png, budget: 280 } });
  const image: WireHistoryImage = { id: hash(png), bytes: Buffer.from(png, "base64").length, budget: 280, rows: 126 };
  assert.deepEqual(await readImageMedia(connection, image, parseDescription(description)), Buffer.from(png, "base64"));
  const fake = (reply: Record<string, unknown>) => ({ maxFrameBytes: 4096, request: async () => reply }) as unknown as WireConnection;
  await assert.rejects(readImageMedia(fake({ offset: 1, total: image.bytes, data: png }), image, parseDescription(description)), /chunk/);
  await assert.rejects(readImageMedia(fake({ offset: 0, total: image.bytes, data: png.slice(0, -4) + "AAAA" }), image, parseDescription(description)), /checksum/);
});


test("media chunks advance by decoded byte count and never trust Base64 character length", async () => {
  const bytes = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(270000, 5)]);
  const image: WireHistoryImage = { id: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, budget: 280, rows: 126 };
  const offsets: number[] = [];
  const connection = { maxFrameBytes: 4096, request: async (request: Record<string, unknown>) => {
    const offset = request.offset as number, limit = request.limit as number;
    offsets.push(offset);
    return { ok: true, offset, total: bytes.length, data: bytes.subarray(offset, offset + limit).toString("base64") };
  } } as unknown as WireConnection;
  assert.deepEqual(await readImageMedia(connection, image, parseDescription(description)), bytes);
  assert.ok(offsets.length > 2);
  assert.equal(offsets[1], 2688);
});

test("the context media limit counts each visual occurrence, including repeated bytes", async (t) => {
  const size = Buffer.from(png, "base64").length;
  const h = await harness({ vision: { ...vision, max_bytes: size, max_context_media_bytes: size } }); t.after(() => h.dispose());
  const changed = png.slice(0, -4) + "AAAA";
  const failed = await collect(h.adapter, context([photo(), photo("other", changed)]), { sessionId: SESSION });
  assert.match(failed.message.errorMessage!, /context media/);
  assert.deepEqual(h.mock.opNames(), ["describe"]);
  const good = await collect(h.adapter, context([photo(), photo()]), { sessionId: SESSION });
  assert.equal(good.message.stopReason, "error");
  assert.match(good.message.errorMessage!, /context media/);
});

test("a too-large image frame never reaches append and never triggers a retry", async (t) => {
  const h = await harness({ vision, maxLine: 4096 }); t.after(() => h.dispose());
  const data = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(4000)]).toString("base64");
  const failed = await collect(h.adapter, context([photo("caption", data)]), { sessionId: SESSION });
  assert.equal(failed.message.stopReason, "error");
  assert.match(failed.message.errorMessage!, /frame/);
  assert.deepEqual(h.mock.opNames(), ["describe", "create"]);
});

test("native Pi attachments are persisted as inline bytes and visual compaction sees them", async (t) => {
  const h = await nativeSession({}, { vision }); t.after(() => h.close());
  h.mock.turns.push({ text: "A cat.", outputTokens: 100 });
  await h.session.prompt("Describe", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
  assert.ok(h.mock.ops.some((op) => op.op === "append" && op.image));
  const file = h.session.sessionFile; assert.ok(file);
  const reopened = SessionManager.open(file).buildSessionContext();
  const saved = reopened.messages.find((m) => m.role === "user")!;
  assert.ok(Array.isArray(saved.content));
  assert.equal((saved.content.find((c) => c.type === "image") as ImageContent).data, png);
  h.mock.turns.push({ text: "Another answer.", outputTokens: 100 });
  await h.session.prompt("Continue");
  h.mock.reset(); h.mock.turns.push({ text: "## Goal\nDescribe a cat.", outputTokens: 100 });
  const compacted = await h.session.compact();
  assert.match(compacted.summary, /cat/);
  const summary = h.mock.ops.find((op) => op.op === "ephemeral")!;
  assert.ok(summary);
  assert.ok((summary.messages as { image?: unknown }[]).some((m) => m.image));
});

test("native Pi read returns image content through the standard tool loop", async (t) => {
  const h = await nativeSession({}, { vision }, true); t.after(() => h.close());
  const path = join(h.root, "screen.png"); writeFileSync(path, Buffer.from(png, "base64"));
  h.session.setActiveToolsByName(["read"]);
  h.mock.turns.push({ calls: [{ name: "read", arguments: { path } }], stop: "tool_use" }, { text: "Image seen." });
  await h.session.prompt(`Read ${path}`);
  const result = h.mock.ops.find((op) => op.op === "append" && op.role === "tool");
  assert.ok(result?.image); assert.equal(result.call_id, 1);
});

test("a failed visual compaction cancels without falling back to image placeholders", async (t) => {
  const h = await nativeSession({}, { vision }); t.after(() => h.close());
  h.mock.turns.push({ text: "A cat.", outputTokens: 100 }, { text: "Another answer.", outputTokens: 100 });
  await h.session.prompt("Describe", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
  await h.session.prompt("Continue");
  const before = h.session.sessionManager.getLeafId();
  h.mock.reset(); h.mock.turns.push({ text: "truncated", stop: "length" });
  await assert.rejects(h.session.compact(), /cancelled/i);
  assert.equal(h.session.sessionManager.getLeafId(), before);
  assert.equal(h.mock.opNames().filter((op) => op === "ephemeral").length, 1);
});

test("native branch summaries receive the abandoned branch's actual images", async (t) => {
  const h = await nativeSession({}, { vision }); t.after(() => h.close());
  h.mock.turns.push({ text: "First answer." }, { text: "Second image." });
  await h.session.prompt("Start");
  const target = h.session.sessionManager.getLeafId(); assert.ok(target);
  await h.session.prompt("Describe", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
  h.mock.reset(); h.mock.turns.push({ text: "Branch contains an image of a cat." });
  const result = await h.session.navigateTree(target, { summarize: true });
  assert.equal(result.cancelled, false);
  assert.match(result.summaryEntry?.summary ?? "", /cat/);
  const summary = h.mock.ops.find((op) => op.op === "ephemeral");
  assert.ok(summary);
  assert.ok((summary.messages as { image?: unknown }[]).some((message) => message.image));
});

test("cancelling during visual history reconciliation prevents a rewind and generation", async (t) => {
  const h = await harness({ vision }); t.after(() => h.dispose());
  const first = await collect(h.adapter, context([photo()]), { sessionId: SESSION });
  await collect(h.adapter, context([photo(), first.message, user("before")]), { sessionId: SESSION });
  const state = h.adapter.liveSession(SESSION)!; state.loaded = false;
  const controller = new AbortController();
  const request = state.connection.request.bind(state.connection);
  state.connection.request = async (value) => {
    const reply = await request(value);
    if (value.op === "history") controller.abort();
    return reply;
  };
  h.mock.reset();
  const result = await collect(h.adapter, context([photo(), first.message, user("edited")]), { sessionId: SESSION, signal: controller.signal });
  assert.equal(result.message.stopReason, "aborted");
  assert.deepEqual(h.mock.opNames(), ["history"]);
});
