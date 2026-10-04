import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { openConnection, type WireConnection } from "../../src/wire/client.js";
import {
  PROVIDER_API,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
  providerModel,
} from "../../src/extensions/provider.js";
import { extensionPaths, packageRoot } from "../../src/launcher.js";
import { xenolithDefaultStateDir } from "../../src/config.js";
import { describeService } from "../../src/wire/describe.js";
import type { WireDescribe } from "../../src/wire/protocol.js";
export interface McpConfig { mcpServers: Record<string, Record<string, unknown>>; }
import type { XenolithSettings } from "../../src/config.js";

export const IDLE_SHUTDOWN_MINUTES = 2;
export const MIN_AVAILABLE_GIB = 21;
export const SHUTDOWN_PATIENCE_MS = 5000; // 3.7: the park is ms now that the model fingerprint is header-only
export const LOG_DIR = join(packageRoot(), "test-logs");

const liveChildren = new Set<ChildProcess>();

function availableGiB(): number {
  const text = readFileSync("/proc/meminfo", "utf8");
  const match = /MemAvailable:\s+(\d+) kB/.exec(text);
  return match?.[1] ? Number(match[1]) / (1024 * 1024) : Number.NaN;
}

export async function waitForEngineBudget(timeoutMs = 120000): Promise<void> {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      const message = `refusing to spawn: battery engine pid ${String(child.pid)} is still alive`;
      console.error(message);
      throw new Error(message);
    }
  }
  const deadline = Date.now() + timeoutMs;
  let available = availableGiB();
  while (!(available >= MIN_AVAILABLE_GIB)) {
    if (Date.now() > deadline) {
      const message = `refusing to spawn: ${available.toFixed(1)} GiB available after ${String(timeoutMs / 1000)}s, need ${String(MIN_AVAILABLE_GIB)} GiB for one engine`;
      console.error(message);
      throw new Error(message);
    }
    await sleep(1000);
    available = availableGiB();
  }
}

export function logPath(name: string): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return join(LOG_DIR, name);
}

export async function stopAllServices(): Promise<void> {
  for (const child of [...liveChildren]) {
    await stopChild(child);
  }
}

process.on("exit", () => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

export function batteryModel(info: WireDescribe): Model<Api> {
  const definition = providerModel(info);
  return {
    id: definition.id,
    name: definition.name,
    api: PROVIDER_API,
    provider: PROVIDER_ID,
    baseUrl: PROVIDER_BASE_URL,
    reasoning: definition.reasoning,
    thinkingLevelMap: definition.thinkingLevelMap,
    input: definition.input,
    cost: definition.cost,
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
  };
}

export function assertNoForeignEngine(): void {
  const lockPath = join(xenolithDefaultStateDir(), "engine.lock");
  if (!existsSync(lockPath)) return;
  let holder = "";
  try {
    holder = readFileSync(lockPath, "utf8");
  } catch {
    return;
  }
  const match = /pid\s+(\d+)/.exec(holder);
  if (!match?.[1]) return;
  const pid = Number(match[1]);
  if (pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  throw new Error(
    `refusing to start the model battery: a xenolith process already holds ${lockPath} (${holder.trim()}). ` +
      "Two weight sets do not fit in memory; stop it first.",
  );
}

export const XENOLITH_BIN = process.env["XENOLITH_BIN"] ?? "";
export const XENOLITH_MODEL = process.env["XENOLITH_MODEL"] ?? "";

export interface Service {
  root: string;
  agentDir: string;
  socket: string;
  stateDir: string;
  cacheDir: string;
  child: ChildProcess;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    if (Date.now() > deadline) throw new Error(`xenolith serve never accepted on ${path}`);
    await sleep(500);
  }
}

export function isolatedRoot(): string {
  return mkdtempSync(join(tmpdir(), "xenopi-model-"));
}

export function patchSettings(agentDir: string, patch: Record<string, unknown>): void {
  const path = join(agentDir, "settings.json");
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2));
}

export function seedAgent(root: string, mcp?: McpConfig): string {
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        extensions: extensionPaths(packageRoot()),
        defaultProvider: PROVIDER_ID,
        quietStartup: true,
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(agentDir, "xenolith.json"),
    JSON.stringify({ bin: XENOLITH_BIN, model: XENOLITH_MODEL, spawn: false }, null, 2),
  );
  if (mcp) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(mcp, null, 2));
  return agentDir;
}

export function spawnService(service: Omit<Service, "child">): ChildProcess {
  if (!XENOLITH_BIN) throw new Error("set XENOLITH_BIN to run the model battery");
  if (!XENOLITH_MODEL) throw new Error("set XENOLITH_MODEL to run the model battery");
  if (!existsSync(XENOLITH_BIN)) throw new Error(`missing xenolith binary at ${XENOLITH_BIN}`);
  if (!existsSync(XENOLITH_MODEL)) throw new Error(`missing model at ${XENOLITH_MODEL}`);
  assertNoForeignEngine();
  const logFd = openSync(logPath(`serve-${String(process.pid)}.log`), "a");
  return spawn(
    XENOLITH_BIN,
    [
      "serve",
      XENOLITH_MODEL,
      "--socket",
      service.socket,
      "--state",
      service.stateDir,
      "--cache",
      service.cacheDir,
      "--idle-shutdown",
      String(IDLE_SHUTDOWN_MINUTES),
    ],
    {
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        XDG_STATE_HOME: join(service.root, "xdg-state"),
        XDG_RUNTIME_DIR: join(service.root, "xdg-runtime"),
      },
    },
  );
}

export async function startService(mcp?: McpConfig): Promise<Service> {
  const root = isolatedRoot();
  const stateDir = join(root, "state");
  const cacheDir = join(root, "cache");
  const socket = join(root, "wire.sock");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(join(root, "xdg-state"), { recursive: true });
  mkdirSync(join(root, "xdg-runtime"), { recursive: true });
  const agentDir = seedAgent(root, mcp);
  const partial = { root, agentDir, socket, stateDir, cacheDir };
  await waitForEngineBudget();
  const child = spawnService(partial);
  liveChildren.add(child);
  await waitForSocket(socket, 600000);
  return { ...partial, child };
}

export async function stopService(service: Service): Promise<void> {
  await stopChild(service.child);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const started = Date.now();
  child.kill("SIGTERM");
  const term = await Promise.race([exited.then(() => true), sleep(SHUTDOWN_PATIENCE_MS).then(() => false)]);
  if (!term) {
    console.error(`[service] pid ${String(child.pid)} did not exit within ${String(SHUTDOWN_PATIENCE_MS / 1000)}s of SIGTERM, escalating to SIGKILL`);
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(10000)]);
  }
  console.error(
    `[service] pid ${String(child.pid)} stopped via ${term ? "SIGTERM" : "SIGKILL"} after ${String(Date.now() - started)}ms exit=${String(child.exitCode)} signal=${String(child.signalCode)}`,
  );
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`xenolith serve pid ${String(child.pid)} refused to die; not spawning another engine`);
  }
  liveChildren.delete(child);
}

export async function restartService(service: Service): Promise<Service> {
  await stopService(service);
  await waitForEngineBudget();
  const child = spawnService(service);
  liveChildren.add(child);
  await waitForSocket(service.socket, 600000);
  return { ...service, child };
}

export function disposeRoot(service: Service): void {
  rmSync(service.root, { recursive: true, force: true });
}

export function wireSettings(service: Service): XenolithSettings {
  return {
    bin: XENOLITH_BIN,
    model: XENOLITH_MODEL,
    socket: service.socket,
    stateDir: service.stateDir,
    cacheDir: service.cacheDir,
    idleShutdownMinutes: IDLE_SHUTDOWN_MINUTES,
    spawn: false,
  };
}

export async function scratchConnection(service: Service): Promise<WireConnection> {
  return openConnection({ settings: wireSettings(service) });
}

export interface SessionHandle {
  session: AgentSession;
  dispose(): Promise<void>;
}

const MANAGED_ENV = [
  "PI_CODING_AGENT_DIR",
  "XENOPI_CODING_AGENT_DIR",
  "XENOLITH_BIN",
  "XENOLITH_MODEL",
  "XENOLITH_SOCKET",
  "XENOLITH_NO_SPAWN",
] as const;

export async function openAgentSession(service: Service, tools?: string[], sessionFile?: string): Promise<SessionHandle> {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) saved.set(key, process.env[key]);
  process.env["PI_CODING_AGENT_DIR"] = service.agentDir;
  process.env["XENOPI_CODING_AGENT_DIR"] = service.agentDir;
  process.env["XENOLITH_BIN"] = XENOLITH_BIN;
  process.env["XENOLITH_MODEL"] = XENOLITH_MODEL;
  process.env["XENOLITH_SOCKET"] = service.socket;
  process.env["XENOLITH_NO_SPAWN"] = "1";
  const settingsManager = SettingsManager.create(service.root, service.agentDir);
  const info = await describeService(wireSettings(service));
  const resourceLoader = new DefaultResourceLoader({
    cwd: service.root, agentDir: service.agentDir, settingsManager,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
  });
  await resourceLoader.reload();
  const options = {
    resourceLoader,
    cwd: service.root,
    agentDir: service.agentDir,
    settingsManager,
    model: batteryModel(info),
    noTools: "all" as const,
    ...(tools ? { tools } : {}),
    ...(sessionFile ? { sessionManager: SessionManager.open(sessionFile, undefined, service.root) } : {}),
  };
  const created = await createAgentSession(options);
  await created.session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  if (created.session.model?.provider !== PROVIDER_ID) {
    created.session.dispose();
    throw new Error(
      `the battery session selected ${String(created.session.model?.provider)}/${String(created.session.model?.id)} instead of ${PROVIDER_ID}/${info.model}`,
    );
  }
  return {
    session: created.session,
    dispose: async () => {
      await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      created.session.dispose();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export async function settle(session: AgentSession, timeoutMs = 600000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!session.isIdle) {
    if (Date.now() > deadline) throw new Error("agent session never settled");
    await sleep(100);
  }
}

export function lastAssistantUsage(session: AgentSession): {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
} {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message && message.role === "assistant") {
      return {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        totalTokens: message.usage.totalTokens,
      };
    }
  }
  throw new Error("no assistant message in the session");
}

export function lastAssistantError(session: AgentSession): string | undefined {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message && message.role === "assistant") return message.errorMessage;
  }
  return undefined;
}
