import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { BindingStore } from "../../src/adapter/bindings.js";
import {
  disposeRoot,
  lastAssistantError,
  lastAssistantUsage,
  openAgentSession,
  restartService,
  scratchConnection,
  settle,
  patchSettings,
  startService,
  stopAllServices,
  type Service,
} from "./service.js";

const here = dirname(fileURLToPath(import.meta.url));
const stdioFixture = join(here, "..", "unit", "fixtures", "mcp-stdio-server.js");

async function withService(
  body: (service: Service) => Promise<Service | void>,
  mcp?: Parameters<typeof startService>[0],
): Promise<void> {
  let service = await startService(mcp);
  try {
    const returned = await body(service);
    if (returned) service = returned;
  } finally {
    await stopAllServices();
    disposeRoot(service);
  }
}

test("multi-turn tool loop is append-only on the wire", async () => {
  await withService(async (service) => {
    const handle = await openAgentSession(service, ["local__echo"]);
    try {
      await handle.session.prompt("Call the local__echo tool with the message ping, then reply done.");
      await settle(handle.session);
      const first = lastAssistantUsage(handle.session);
      assert.ok(first.totalTokens > 0);

      await handle.session.prompt("Reply with one short sentence.");
      await settle(handle.session);
      const second = lastAssistantUsage(handle.session);

      assert.ok(
        second.cacheRead >= first.totalTokens * 0.9,
        `expected the second turn to reuse the first turn's KV, got cacheRead=${second.cacheRead} vs total=${first.totalTokens}`,
      );
      assert.ok(second.input < 200, `expected a small prefill, got input=${second.input}`);
    } finally {
      handle.dispose();
    }
  }, { servers: { local: { transport: "stdio", command: process.execPath, args: [stdioFixture] } } });
});

test("a service restart resumes the session at near-zero prefill", async () => {
  await withService(async (service) => {
    const first = await openAgentSession(service);
    let sessionFile: string | undefined;
    try {
      await first.session.prompt("Say hello in one short sentence.");
      await settle(first.session);
      const before = lastAssistantUsage(first.session);
      assert.ok(before.totalTokens > 0);
      sessionFile = first.session.sessionFile;
      assert.ok(sessionFile);
    } finally {
      first.dispose();
    }

    const restarted = await restartService(service);
    const second = await openAgentSession(restarted, undefined, sessionFile);
    try {
      await second.session.prompt("Say goodbye in one short sentence.");
      await settle(second.session);
      const after = lastAssistantUsage(second.session);
      assert.ok(
        after.cacheRead > 0,
        `expected the restarted service to resume from a checkpoint, got ${JSON.stringify(after)}`,
      );
      assert.ok(after.input < 200, `expected a near-zero prefill after restart, got input=${after.input}`);
    } finally {
      second.dispose();
    }
    return restarted;
  });
});

test("branch navigation rewinds the wire record instead of rebuilding", async () => {
  await withService(async (service) => {
    const handle = await openAgentSession(service);
    try {
      await handle.session.prompt("Answer with the single word alpha.");
      await settle(handle.session);
      const entries = handle.session.messages.length;
      assert.ok(entries >= 2);

      const branchPoint = handle.session.getUserMessagesForForking()[0];
      assert.ok(branchPoint);

      await handle.session.prompt("Answer with the single word beta.");
      await settle(handle.session);

      const navigation = await handle.session.navigateTree(branchPoint.entryId, { summarize: false });
      assert.equal(navigation.cancelled, false);

      await handle.session.prompt("Answer with the single word gamma.");
      await settle(handle.session);
      const usage = lastAssistantUsage(handle.session);
      assert.ok(usage.cacheRead > 0, "expected the rewound prefix to be served from KV");
      assert.ok(usage.input < 200, `expected a small prefill after a rewind, got input=${usage.input}`);

      const bindings = new BindingStore(service.agentDir);
      const wireSession = bindings.get(handle.session.sessionId);
      assert.ok(wireSession);
      const connection = await scratchConnection(service);
      try {
        await connection.request({ op: "open", session: wireSession });
        const history = await connection.request({ op: "history" });
        const kinds = (history["entries"] as { kind: string; text: string }[]).map((entry) => entry.kind);
        assert.equal(kinds[0], "system");
        assert.ok(
          !(history["entries"] as { text: string }[]).some((entry) => entry.text.includes("beta")),
          "the abandoned branch must not be visible on the wire after a rewind",
        );
      } finally {
        connection.close();
      }
    } finally {
      handle.dispose();
    }
  });
});

test("compaction runs through session_before_compact at near-zero prefill", async () => {
  await withService(async (service) => {
    patchSettings(service.agentDir, { compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } });
    const handle = await openAgentSession(service);
    try {
      await handle.session.prompt("Say alpha.");
      await settle(handle.session);
      await handle.session.prompt("Say beta.");
      await settle(handle.session);
      const before = lastAssistantUsage(handle.session);
      const messagesBefore = handle.session.messages.length;

      const result = await handle.session.compact();
      await settle(handle.session);

      assert.ok(result.summary.length > 0);
      assert.ok(result.usage);
      assert.equal(result.usage.cost.total, 0);
      assert.ok(
        result.usage.cacheRead >= before.totalTokens * 0.9,
        `expected the summary turn to prefill nothing new, got cacheRead=${result.usage.cacheRead}`,
      );
      assert.ok(result.usage.input < 400, `expected a near-zero prefill summary, got input=${result.usage.input}`);
      assert.ok(handle.session.messages.length < messagesBefore, "pi's context must be compacted afterwards");
    } finally {
      handle.dispose();
    }
  });
});

test("an oversized prompt surfaces context_length_exceeded and pi recovers", async () => {
  await withService(async (service) => {
    const handle = await openAgentSession(service);
    try {
      await handle.session.prompt("Say alpha.");
      await settle(handle.session);

      const oversized = `Ignore this filler. ${"filler ".repeat(300000)}Answer with one word.`;
      await handle.session.prompt(oversized);
      await settle(handle.session);

      const errorMessage = lastAssistantError(handle.session);
      const overflowed =
        errorMessage !== undefined &&
        isContextOverflow(
          {
            role: "assistant",
            content: [],
            api: "xenolith-wire",
            provider: "xenolith",
            model: "gemma-4-26B-A4B-it-qat",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage,
            timestamp: Date.now(),
          },
          262144,
        );
      const compacted = readFileSync(handle.session.sessionFile ?? "/dev/null", "utf8").includes('"type":"compaction"');
      assert.ok(
        overflowed || compacted,
        `expected the wire overflow to reach pi's recovery path, error was ${String(errorMessage)}`,
      );
    } finally {
      handle.dispose();
    }
  });
});

test("an MCP tool executes end to end inside the agent loop", async () => {
  await withService(async (service) => {
    const handle = await openAgentSession(service, ["local__echo"]);
    try {
      assert.ok(handle.session.getAllTools().some((tool) => tool.name === "local__echo"));
      await handle.session.prompt("Use the local__echo tool with message xenopi and then repeat its output.");
      await settle(handle.session);

      const results = handle.session.messages.filter((message) => message.role === "toolResult");
      assert.ok(results.length > 0, "expected the MCP tool to have executed");
      const text = results
        .flatMap((message) => (message.role === "toolResult" ? message.content : []))
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(" ");
      assert.match(text, /stdio:xenopi/);
    } finally {
      handle.dispose();
    }
  }, { servers: { local: { transport: "stdio", command: process.execPath, args: [stdioFixture] } } });
});

test("the orphan sweep deletes wire sessions for deleted pi sessions", async () => {
  await withService(async (service) => {
    const keep = await openAgentSession(service);
    let keptWire: string | undefined;
    try {
      await keep.session.prompt("Say alpha.");
      await settle(keep.session);
      keptWire = new BindingStore(service.agentDir).get(keep.session.sessionId);
      assert.ok(keptWire);
    } finally {
      keep.dispose();
    }
    const handle = await openAgentSession(service);
    let wireSession: string | undefined;
    let sessionDir: string | undefined;
    let doomedFile: string | undefined;
    let doomedPi: string | undefined;
    try {
      await handle.session.prompt("Say beta.");
      await settle(handle.session);
      doomedPi = handle.session.sessionId;
      wireSession = new BindingStore(service.agentDir).get(handle.session.sessionId);
      assert.ok(wireSession);
      doomedFile = handle.session.sessionFile;
      assert.ok(doomedFile);
      sessionDir = dirname(doomedFile);
    } finally {
      handle.dispose();
    }
    rmSync(doomedFile as string);
    const { activeAdapters } = await import("../../src/extensions/provider.js");
    for (const live of activeAdapters()) live.close();

    const { XenolithAdapter } = await import("../../src/adapter/adapter.js");
    const { wireSettings } = await import("./service.js");
    const adapter = new XenolithAdapter({ agentDir: service.agentDir, settings: wireSettings(service) });
    const removed = await adapter.sweep(sessionDir);
    adapter.close();

    assert.deepEqual(removed, [doomedPi]);
    const connection = await scratchConnection(service);
    try {
      const listed = await connection.request({ op: "list" });
      const sessions = (listed["sessions"] as { session: string }[]).map((entry) => entry.session);
      assert.ok(!sessions.includes(wireSession as string));
      assert.ok(sessions.includes(keptWire as string));
    } finally {
      connection.close();
    }
  });
});

after(async () => {
  await stopAllServices();
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
});
