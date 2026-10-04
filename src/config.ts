import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface XenolithSettings {
  bin: string;
  model: string | undefined;
  socket: string;
  stateDir: string | undefined;
  cacheDir: string | undefined;
  idleShutdownMinutes: number;
  spawn: boolean;
}

export interface XenolithSettingsFile {
  bin?: string;
  model?: string;
  socket?: string;
  stateDir?: string;
  cacheDir?: string;
  idleShutdownMinutes?: number;
  spawn?: boolean;
}

export const SETTINGS_FILE_NAME = "xenolith.json";
export const BINDINGS_FILE_NAME = "wire-bindings.json";
export const AGENT_DIR_ENV = "XENOPI_DIR";
export const XENOPI_AGENT_DIR_ENV = "XENOPI_CODING_AGENT_DIR";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

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
  const idleParsed = idleEnv !== undefined ? Number(idleEnv) : Number.NaN;
  return {
    bin: env["XENOLITH_BIN"] ?? file.bin ?? "xenolith",
    model: env["XENOLITH_MODEL"] ?? file.model,
    socket: socketEnv && socketEnv.length > 0 ? socketEnv : (file.socket ?? defaultSocketPath(env)),
    stateDir: env["XENOLITH_STATE_DIR"] ?? file.stateDir,
    cacheDir: env["XENOLITH_CACHE_DIR"] ?? file.cacheDir,
    idleShutdownMinutes: Number.isFinite(idleParsed) ? idleParsed : (file.idleShutdownMinutes ?? 30),
    spawn: env["XENOLITH_NO_SPAWN"] === "1" ? false : (file.spawn ?? true),
  };
}

export function bindingsPath(agentDir: string): string {
  return join(agentDir, BINDINGS_FILE_NAME);
}
