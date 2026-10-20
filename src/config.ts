import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface XenolithSettings {
  bin: string;
  model: string | undefined;
  /** Existing Xenolith encoder/projector; only used when spawning the service. */
  mmproj?: string;
  /** Visual row budget; the service validates its supported values. */
  imageBudget?: number;
  socket: string;
  stateDir: string | undefined;
  cacheDir: string | undefined;
  cacheBudget?: string;
  /** Requested capacity when spawning; describe remains authoritative. */
  context?: number;
  idleShutdownMinutes: number;
  spawn: boolean;
}

export interface XenolithSettingsFile {
  bin?: string;
  model?: string;
  mmproj?: string;
  imageBudget?: number;
  socket?: string;
  stateDir?: string;
  cacheDir?: string;
  cacheBudget?: string | number;
  context?: number;
  idleShutdownMinutes?: number;
  spawn?: boolean;
}

export const SETTINGS_FILE_NAME = "xenolith.json";
export const BINDINGS_FILE_NAME = "wire-bindings.json";
export const AGENT_DIR_ENV = "XENOPI_DIR";
export const XENOPI_AGENT_DIR_ENV = "XENOPI_CODING_AGENT_DIR";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const CACHE_BUDGET_MAX = 18446744073709551615n;
const CACHE_BUDGET_UNITS: Record<string, bigint> = {
  "": 1n,
  B: 1n,
  kB: 1000n,
  MB: 1000_000n,
  GB: 1000_000_000n,
  KiB: 1024n,
  MiB: 1024n * 1024n,
  GiB: 1024n * 1024n * 1024n,
};

export function normalizeCacheBudget(value: unknown): string {
  let input: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("cacheBudget must be a non-negative safe integer or size string");
    }
    input = String(value);
  } else if (typeof value === "string") {
    input = value;
  } else {
    throw new Error("cacheBudget must be a non-negative safe integer or size string");
  }
  const match = /^(\d+)(kB|MB|GB|KiB|MiB|GiB|B)?$/.exec(input);
  if (!match || match[0] !== input) {
    throw new Error(`invalid cacheBudget: ${JSON.stringify(input)}`);
  }
  const count = BigInt(match[1]!);
  const unit = match[2] ?? "";
  const bytes = count * CACHE_BUDGET_UNITS[unit]!;
  if (bytes > CACHE_BUDGET_MAX) throw new Error("cacheBudget exceeds uint64 byte range");
  return bytes.toString();
}

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AGENT_DIR_ENV];
  if (override && override.length > 0) return override;
  return join(env["HOME"] ?? homedir(), ".xenopi", "agent");
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const managed = env[XENOPI_AGENT_DIR_ENV] ?? env[PI_AGENT_DIR_ENV];
  if (managed && managed.length > 0) return managed;
  return defaultAgentDir(env);
}

export function xenolithDefaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env["XDG_STATE_HOME"];
  if (state && state.startsWith("/")) return join(state, "xenolith");
  return join(env["HOME"] ?? homedir(), ".local", "state", "xenolith");
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime && runtime.startsWith("/")) return join(runtime, "xenolith", "wire.sock");
  return join(xenolithDefaultStateDir(env), "wire.sock");
}

export function readSettingsFile(agentDir: string): XenolithSettingsFile {
  const path = join(agentDir, SETTINGS_FILE_NAME);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as XenolithSettingsFile;
  } catch {
    return {};
  }
}

export function resolveXenolithSettings(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): XenolithSettings {
  const file = readSettingsFile(agentDir);
  const socketEnv = env["XENOLITH_SOCKET"];
  const idleEnv = env["XENOLITH_IDLE_SHUTDOWN"];
  const cacheBudget = env["XENOLITH_CACHE_BUDGET"] ?? file.cacheBudget;
  const idleParsed = idleEnv !== undefined ? Number(idleEnv) : Number.NaN;
  const contextEnv = env["XENOLITH_CONTEXT"];
  const imageBudgetEnv = env["XENOLITH_IMAGE_BUDGET"];
  const imageBudget = imageBudgetEnv === undefined ? file.imageBudget :
    /^[0-9]+$/.test(imageBudgetEnv) ? Number(imageBudgetEnv) : Number.NaN;
  const context = contextEnv !== undefined
    ? validateContextCapacity(/^[0-9]+$/.test(contextEnv) ? Number(contextEnv) : Number.NaN, "XENOLITH_CONTEXT")
    : file.context === undefined ? undefined : validateContextCapacity(file.context, '"context" in xenolith.json');
  return {
    bin: env["XENOLITH_BIN"] ?? file.bin ?? "xenolith",
    model: env["XENOLITH_MODEL"] ?? file.model,
    mmproj: env["XENOLITH_MMPROJ"] ?? file.mmproj,
    imageBudget: imageBudget === undefined ? undefined : validateContextCapacity(imageBudget, "imageBudget"),
    socket: socketEnv && socketEnv.length > 0 ? socketEnv : (file.socket ?? defaultSocketPath(env)),
    stateDir: env["XENOLITH_STATE_DIR"] ?? file.stateDir,
    cacheDir: env["XENOLITH_CACHE_DIR"] ?? file.cacheDir,
    cacheBudget: cacheBudget === undefined ? undefined : normalizeCacheBudget(cacheBudget),
    context,
    idleShutdownMinutes: Number.isFinite(idleParsed) ? idleParsed : (file.idleShutdownMinutes ?? 30),
    spawn: env["XENOLITH_NO_SPAWN"] === "1" ? false : (file.spawn ?? true),
  };
}

/** Model and implementation limits belong to the engine, not the client. */
export function validateContextCapacity(value: unknown, source = "context"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${source} must be a positive safe integer (token count)`);
  }
  return value;
}

export function bindingsPath(agentDir: string): string {
  return join(agentDir, BINDINGS_FILE_NAME);
}
