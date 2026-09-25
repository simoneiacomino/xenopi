import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { XenolithAdapter, type Classification } from "../../src/adapter/adapter.js";
import type { XenolithSettings } from "../../src/config.js";
import { MODEL_ID, PROVIDER_API, PROVIDER_ID } from "../../src/extensions/provider.js";
import { MockWireServer, type MockWireOptions } from "./mock-wire.js";

export const model: Model<Api> = {
  id: MODEL_ID,
  name: "Gemma 4 26B A4B (xenolith)",
  api: PROVIDER_API,
  provider: PROVIDER_ID,
  baseUrl: "unix:///xenolith/wire.sock",
  reasoning: true,
  thinkingLevelMap: { minimal: null, xhigh: null, max: "max" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262144,
  maxTokens: 262144,
};

export function settingsFor(socket: string): XenolithSettings {
  return {
    bin: "/nonexistent/xenolith",
    model: undefined,
    socket,
    stateDir: undefined,
    cacheDir: undefined,
    idleShutdownMinutes: 30,
    spawn: false,
  };
}

export interface Harness {
  mock: MockWireServer;
  agentDir: string;
  adapter: XenolithAdapter;
  classifications: Classification[];
  notices: string[];
  logs: string[];
  newAdapter(): XenolithAdapter;
  dispose(): Promise<void>;
}

export async function harness(options: MockWireOptions = {}): Promise<Harness> {
  const mock = await MockWireServer.start(options);
  const agentDir = mkdtempSync(join(tmpdir(), "xenopi-agent-"));
  const classifications: Classification[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const adapters: XenolithAdapter[] = [];
  const newAdapter = (): XenolithAdapter => {
    const adapter = new XenolithAdapter({
      agentDir,
      settings: settingsFor(mock.socketPath),
      onClassification: (classification) => classifications.push(classification),
      onNotice: (message) => notices.push(message),
      log: (message) => {
        logs.push(message);
        process.stderr.write(`${message}\n`);
      },
    });
    adapters.push(adapter);
    return adapter;
  };
  const adapter = newAdapter();
  return {
    mock,
    agentDir,
    adapter,
    classifications,
    notices,
    logs,
    newAdapter,
    async dispose(): Promise<void> {
      for (const entry of adapters) entry.close();
      await mock.stop();
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(mock.directory, { recursive: true, force: true });
    },
  };
}

export function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

export function toolResult(id: string, name: string, text: string, isError = false): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
}

export function context(messages: Message[], systemPrompt = "You are helpful.", tools?: Context["tools"]): Context {
  const built: Context = { systemPrompt, messages };
  if (tools) built.tools = tools;
  return built;
}

export interface Collected {
  events: AssistantMessageEvent[];
  message: AssistantMessage;
}

export async function collect(
  adapter: XenolithAdapter,
  ctx: Context,
  options?: SimpleStreamOptions,
): Promise<Collected> {
  const stream = adapter.streamSimple(model, ctx, options);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

export function assistant(text: string): Message {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "xenolith-wire",
    provider: "xenolith",
    model: "gemma-4-26B-A4B-it-qat",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
  return message;
}

export function assistantFrom(collected: Collected): Message {
  return collected.message;
}
