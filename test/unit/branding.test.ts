import assert from "node:assert/strict";
import test from "node:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import xenopiBranding, {
  brandSystemPrompt,
  installXenoPiHeader,
  XENOPI_IDENTITY,
} from "../../src/extensions/branding.js";

test("brandSystemPrompt replaces pi's stock identity", () => {
  const stock =
    "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- When reading pi docs or examples, follow links\n- When working on pi topics, read docs\n- Always read pi .md files completely";
  const branded = brandSystemPrompt(stock);
  assert.equal(branded.startsWith(XENOPI_IDENTITY), true);
  assert.equal(branded.includes("operating inside pi, a coding agent harness"), false);
  assert.match(branded, /XenoPi runtime documentation/);
  assert.doesNotMatch(branded, /Pi documentation/);
  assert.equal(brandSystemPrompt(branded), branded);
});

test("brandSystemPrompt prepends the identity to a custom prompt", () => {
  assert.equal(brandSystemPrompt("Be terse."), `${XENOPI_IDENTITY}\n\nBe terse.`);
});

test("the branding extension installs the identity hook", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  xenopiBranding(pi);
  const handler = handlers.get("before_agent_start");
  assert.ok(handler);
  const result = await handler(
    { type: "before_agent_start", systemPrompt: "Custom." } as BeforeAgentStartEvent,
    {} as ExtensionContext,
  );
  assert.deepEqual(result, { systemPrompt: `${XENOPI_IDENTITY}\n\nCustom.` });
});

test("the XenoPi header replaces the stock pi header in TUI mode", () => {
  let factory: ((tui: unknown, theme: typeof fakeTheme) => { render(): string[] }) | undefined;
  const fakeTheme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
  const ctx = {
    mode: "tui",
    ui: {
      setHeader(value: typeof factory): void {
        factory = value;
      },
    },
  } as unknown as ExtensionContext;
  installXenoPiHeader(ctx);
  assert.ok(factory);
  const output = factory({}, fakeTheme).render().join("\n");
  assert.match(output, /xenopi/);
  assert.match(output, /XenoPi runs local models through Xenolith/);
  assert.doesNotMatch(output, /Pi can explain/);
});
