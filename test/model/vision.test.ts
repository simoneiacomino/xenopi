import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { BindingStore } from "../../src/adapter/bindings.js";
import { imageFormat, imageId, readImageMedia } from "../../src/wire/images.js";
import { parseDescription } from "../../src/wire/describe.js";
import type { WireHistoryEntry } from "../../src/wire/protocol.js";
import { packageRoot } from "../../src/launcher.js";
import { openAgentSession, restartService, startService, stopAllServices, disposeRoot, lastAssistantError, lastAssistantUsage,
  scratchConnection, logPath, patchSettings, settle } from "./service.js";

const mmproj = process.env["XENOLITH_MMPROJ"];
const imagePath = process.env["XENOLITH_TEST_IMAGE"];
const execFileAsync = promisify(execFile);
function text(session: AgentSession): string {
  const message = [...session.messages].reverse().find((m) => m.role === "assistant");
  return message?.role === "assistant" ? message.content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
}

for (const capacity of [65536, 131072]) {
  test(`native kitten attachment, tool image, resume and compaction at ${capacity}`, { skip: !mmproj || !imagePath }, async () => {
    let service = await startService(undefined, { mmproj, context: capacity });
    const measurements: Record<string, unknown>[] = [];
    const bytes = readFileSync(imagePath!);
    const image = { type: "image" as const, data: bytes.toString("base64"), mimeType: `image/${imageFormat(bytes)}` };
    const timed = async (name: string, session: AgentSession, body: () => Promise<unknown>) => {
      let firstContent: number | undefined;
      const start = performance.now();
      const off = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && firstContent === undefined) firstContent = performance.now() - start;
      });
      try { await body(); await settle(session); } finally { off(); }
      assert.equal(lastAssistantError(session), undefined);
      measurements.push({ name, elapsed_ms: performance.now() - start, first_content_ms: firstContent, usage: lastAssistantUsage(session), text: text(session) });
    };
    try {
      patchSettings(service.agentDir, { compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1 } });
      const first = await openAgentSession(service);
      let file: string;
      let wireSession: string;
      try {
        await timed("kitten", first.session, () => first.session.prompt("What animal is in this image? Answer briefly in English.", { images: [image] }));
        assert.match(text(first.session), /cat|kitten/i);
        await timed("text_followup", first.session, () => first.session.prompt("Briefly describe the animal's fur."));
        assert.ok(lastAssistantUsage(first.session).cacheRead > 0);
        file = first.session.sessionFile!;
        wireSession = new BindingStore(service.agentDir).get(first.session.sessionManager.getSessionId())!;
        assert.ok(wireSession);
      } finally { await first.dispose(); }
      // Export bytes from Xenolith and verify the original source identity.
      const connection = await scratchConnection(service);
      try {
        const info = parseDescription(await connection.request({ op: "describe" }));
        connection.maxFrameBytes = info.max_frame;
        await connection.request({ op: "open", session: wireSession });
        const history = await connection.request({ op: "history" });
        const entry = (history.entries as WireHistoryEntry[]).find((e) => e.image)!;
        assert.ok(entry.image); assert.equal(entry.image.id, imageId(bytes));
        assert.deepEqual(await readImageMedia(connection, entry.image, info), bytes);
      } finally { connection.close(); }
      const cliStart = performance.now();
      const cli = execFileAsync(process.execPath, [join(packageRoot(), "dist/src/bin/xenopi.js"), "--print", "--thinking", "off", "--no-tools", "--no-session", `@${imagePath}`, "What animal is in this image? Answer briefly in English."], {
        cwd: service.root, env: { ...process.env, XENOPI_DIR: service.agentDir, XENOLITH_SOCKET: service.socket, XENOLITH_NO_SPAWN: "1" },
        timeout: 600000, maxBuffer: 1024 * 1024,
      });
      cli.child.stdin?.end();
      const cliResult = await cli;
      assert.match(cliResult.stdout, /cat|kitten/i);
      measurements.push({ name: "cli_attachment", elapsed_ms: performance.now() - cliStart, stdout: cliResult.stdout, stderr: cliResult.stderr });
      service = await restartService(service);
      const resumed = await openAgentSession(service, undefined, file);
      try {
        await timed("resumed_followup", resumed.session, () => resumed.session.prompt("What animal did I show you? Answer briefly in English."));
        assert.match(text(resumed.session), /cat|kitten/i);
        assert.ok(lastAssistantUsage(resumed.session).cacheRead > 0);
        const start = performance.now();
        const compacted = await resumed.session.compact("Keep the animal's identity and appearance.");
        assert.match(compacted.summary, /cat|kitten/i);
        measurements.push({ name: "visual_compaction", elapsed_ms: performance.now() - start, summary: compacted.summary });
        await timed("compacted_followup", resumed.session, () => resumed.session.prompt("What animal did I show you? Answer briefly in English."));
        assert.match(text(resumed.session), /cat|kitten/i);
      } finally { await resumed.dispose(); }
      const readSession = await openAgentSession(service, ["read"]);
      try {
        await timed("read_tool_image", readSession.session, () => readSession.session.prompt(`Use the read tool to inspect ${imagePath}, then name the animal in one sentence.`));
        assert.match(text(readSession.session), /cat|kitten/i);
        const toolResult = readSession.session.messages.find((m) => m.role === "toolResult");
        assert.ok(toolResult && Array.isArray(toolResult.content) && toolResult.content.some((c) => c.type === "image"));
      } finally { await readSession.dispose(); }
    } finally {
      writeFileSync(logPath(`vision-${capacity}.json`), JSON.stringify({ capacity, image: imagePath, image_sha256: imageId(bytes), measurements }, null, 2));
      await stopAllServices(); disposeRoot(service);
    }
  });
}
