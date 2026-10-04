import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import xenolithProvider, { providerModel, PROVIDER_API, PROVIDER_ID, PROVIDER_BASE_URL } from "../../src/extensions/provider.js";
import { describeService } from "../../src/wire/describe.js";
import { settingsFor } from "./harness.js";
import { MockWireServer } from "./mock-wire.js";

export async function nativeSession(mcpServers: Record<string, unknown> = {}) {
  const mock = await MockWireServer.start({ model: "arbitrary-service-model", contextWindow: 131072 });
  const root = mkdtempSync(join(tmpdir(), "xenopi-native-"));
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers }));
  const managed = { PI_CODING_AGENT_DIR: root, XENOPI_CODING_AGENT_DIR: root, XENOLITH_SOCKET: mock.socketPath, XENOLITH_NO_SPAWN: "1" };
  const previous = new Map(Object.keys(managed).map((key) => [key, process.env[key]]));
  Object.assign(process.env, managed);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noSkills: true, noPromptTemplates: true,
    extensionFactories: [xenolithProvider, createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
  });
  await loader.reload();
  const info = await describeService(settingsFor(mock.socketPath));
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
    model: { ...providerModel(info), api: PROVIDER_API, provider: PROVIDER_ID, baseUrl: PROVIDER_BASE_URL },
    noTools: "builtin", thinkingLevel: "off", sessionManager: SessionManager.create(root, join(root, "sessions")),
  });
  if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  mock.reset();
  return {
    mock, session, root,
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      await mock.stop();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(mock.directory, { recursive: true, force: true });
    },
  };
}
