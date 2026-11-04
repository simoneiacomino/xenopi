import { spawn } from "node:child_process";
import type { XenolithSettings } from "../config.js";
import { WireError } from "./protocol.js";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8192;
const TIMEOUT_MS = 5000;

export class DiscoveryUnavailableError extends Error {
  constructor(readonly reason: "missing_binary" | "unsupported", message: string) {
    super(message);
    this.name = "DiscoveryUnavailableError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolute(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw new WireError("invalid_request", `invalid Xenolith config inspect response: ${name} must be an absolute path`);
  }
  return value;
}

/** Parse the public CLI contract, not the native inference configuration. */
export function applyInspection(settings: XenolithSettings, value: unknown): XenolithSettings {
  if (!object(value) || value["schema_version"] !== 1 ||
      typeof value["config_present"] !== "boolean" ||
      !object(value["endpoint"]) || value["endpoint"]["transport"] !== "unix") {
    throw new WireError("invalid_request", "invalid Xenolith config inspect response: unsupported schema or endpoint");
  }
  const configPath = absolute(value["config_path"], "config_path");
  const socket = absolute(value["endpoint"]["path"], "endpoint.path");
  const stateDir = absolute(value["state_dir"], "state_dir");
  const cacheDir = absolute(value["cache_dir"], "cache_dir");
  const engineLock = absolute(value["engine_lock"], "engine_lock");
  const logPath = absolute(value["log_path"], "log_path");
  if (settings.discovery?.socketExplicit && socket !== settings.socket) {
    throw new WireError("invalid_request", "Xenolith config inspect did not preserve the explicit socket");
  }
  if (settings.stateDir !== undefined && stateDir !== settings.stateDir ||
      settings.cacheDir !== undefined && cacheDir !== settings.cacheDir) {
    throw new WireError("invalid_request", "Xenolith config inspect did not preserve explicit state/cache paths");
  }
  if (settings.discovery?.configPath !== undefined && configPath !== settings.discovery.configPath) {
    throw new WireError("invalid_request", "Xenolith config inspect did not preserve the selected config path");
  }
  return {
    ...settings,
    socket,
    stateDir,
    cacheDir,
    nativeService: {
      configPath,
      configPresent: value["config_present"],
      engineLock,
      logPath,
    },
  };
}

/** Older Xenolith versions print this exact usage header for unknown commands. */
function unsupported(stdout: string, stderr: string, code: number | null): boolean {
  if (code !== 1 || stdout.trim() !== "") return false;
  return (/^Usage: xenolith <command> <model\.gguf> \[options\](?:\r?\n|$)/.test(stderr) &&
      !/^\s+config\s/m.test(stderr)) ||
    /^xenolith: unknown command ['"]?config['"]?\s*$/m.test(stderr);
}

/** Resolve the engine's bootstrap paths without loading a model or reading its file. */
export async function inspectService(settings: XenolithSettings): Promise<XenolithSettings> {
  const args = ["config", "inspect", "--json"];
  if (settings.discovery?.configPath) args.push("--config", settings.discovery.configPath);
  if (settings.discovery?.socketExplicit) args.push("--socket", settings.socket);
  if (settings.stateDir !== undefined) args.push("--state", settings.stateDir);
  if (settings.cacheDir !== undefined) args.push("--cache", settings.cacheDir);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(settings.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: settings.discovery?.env,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop(new WireError("io_error", "Xenolith config inspect timed out after 5 seconds")), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        stop(new WireError("io_error", "Xenolith config inspect exceeded the 64 KiB output limit"));
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = error.code === "ENOENT"
        ? new DiscoveryUnavailableError("missing_binary", `cannot find Xenolith executable ${JSON.stringify(settings.bin)}; install it on PATH or set XENOLITH_BIN`)
        : new WireError("io_error", `cannot run Xenolith config inspect: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      const stdout = Buffer.concat(chunks).toString("utf8");
      const diagnostic = stderr.toString("utf8").trim();
      if (code !== 0) {
        if (unsupported(stdout, diagnostic, code)) {
          reject(new DiscoveryUnavailableError("unsupported", "this Xenolith binary does not support native configuration; update Xenolith or configure an explicit legacy model"));
        } else {
          reject(new WireError("io_error", `Xenolith config inspect failed (${signal ?? code}): ${diagnostic || "no diagnostic"}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw new WireError("invalid_request", "Xenolith config inspect returned malformed JSON"); }
  return applyInspection(settings, value);
}
