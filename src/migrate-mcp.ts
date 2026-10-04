import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One-time file conversion only. All MCP connections and tools belong to Pi. */
export function migrateMcpConfig(agentDir: string): boolean {
  const path = join(agentDir, "mcp.json");
  if (!existsSync(path)) return false;
  const original = readFileSync(path, "utf8");
  const config: unknown = JSON.parse(original);
  if (!object(config) || !("servers" in config)) return false;
  if (!object(config.servers) || (config.mcpServers !== undefined && !object(config.mcpServers))) {
    throw new Error(`xenopi: invalid MCP configuration in ${path}; migrate it to mcpServers`);
  }
  const servers = { ...(config.mcpServers as Record<string, unknown> | undefined) };
  const names = new Set(Object.keys(servers).map((name) => name.replaceAll("-", "_")));
  for (const [name, entry] of Object.entries(config.servers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || names.has(name.replaceAll("-", "_"))) {
      throw new Error(`xenopi: MCP server name ${name} conflicts with the native format; migrate ${path} manually`);
    }
    names.add(name.replaceAll("-", "_"));
    if (!object(entry) || !["stdio", "http"].includes(String(entry.transport))) {
      throw new Error(`xenopi: invalid legacy MCP server ${name} in ${path}`);
    }
    const allowed = new Set(["transport", "command", "args", "env", "cwd", "url", "headers", "token", "timeoutMs"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new Error(`xenopi: unrecognized fields on MCP server ${name}; migrate ${path} manually`);
    }
    const { transport, token, timeoutMs, ...native } = entry;
    if (transport === "stdio" ? typeof native.command !== "string" : typeof native.url !== "string") {
      throw new Error(`xenopi: missing MCP command or URL for ${name}`);
    }
    if (token !== undefined) {
      if (transport !== "http" || typeof token !== "string" || (native.headers !== undefined && !object(native.headers))) {
        throw new Error(`xenopi: invalid MCP token or headers for ${name}`);
      }
      if (token) native.headers = { ...(native.headers as Record<string, unknown> | undefined), Authorization: `Bearer ${token}` };
    }
    // Pi evaluates these forms; the old client sent literal strings. Do not
    // turn a stored literal into a command or variable expansion on upgrade.
    for (const field of [native.headers, native.env]) {
      if (field === undefined) continue;
      if (!object(field) || Object.values(field).some((value) =>
        typeof value !== "string" || value.startsWith("!") || value.includes("${"))) {
        throw new Error(`xenopi: MCP headers or env for ${name} need manual migration to Pi's interpolation syntax`);
      }
    }
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`xenopi: invalid MCP timeout for ${name}`);
      }
      native.timeout = timeoutMs / 1000;
    }
    // Omit exposure to use Pi's native codemode default.
    servers[name] = native;
  }
  const backup = `${path}.pre-pi-1.0.2.bak`;
  if (existsSync(backup)) {
    if (readFileSync(backup, "utf8") !== original) {
      throw new Error(`xenopi: refusing to overwrite MCP backup ${backup}`);
    }
  } else {
    writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
  }
  const { servers: _legacy, ...rest } = config;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...rest, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  process.stderr.write(`xenopi: migrated MCP configuration; backup: ${backup}. Tools now use Pi names and codemode exposure.\n`);
  return true;
}
