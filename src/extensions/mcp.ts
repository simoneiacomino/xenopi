import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { mcpConfigPath, resolveAgentDir } from "../config.js";
import { XENOPI_VERSION } from "../product.js";

export interface McpHttpServerConfig {
  transport: "http";
  url: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

export const CLIENT_INFO = { name: "xenopi", version: XENOPI_VERSION };

export function readMcpConfig(agentDir: string): McpConfig {
  const path = mcpConfigPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as McpConfig;
  } catch {
    return {};
  }
}

export function createTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    const options: ConstructorParameters<typeof StdioClientTransport>[0] = {
      command: config.command,
      args: config.args ?? [],
    };
    if (config.env) options.env = { ...config.env };
    if (config.cwd) options.cwd = config.cwd;
    return new StdioClientTransport(options);
  }
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export function qualifiedName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

type JsonObject = Record<string, unknown>;

const PROFILE_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePointer(root: JsonObject, pointer: string): JsonObject | undefined {
  if (!pointer.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return isObject(current) ? current : undefined;
}

function inferConstType(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (isObject(value)) return "object";
  return undefined;
}

function normalizeNode(node: unknown, root: JsonObject, depth: number, dropped: string[], path: string): JsonObject | undefined {
  if (!isObject(node) || depth > 12) return undefined;
  let current: JsonObject = node;
  const seen = new Set<string>();
  while (typeof current["$ref"] === "string") {
    const pointer = current["$ref"];
    if (seen.has(pointer)) return undefined;
    seen.add(pointer);
    const target = resolvePointer(root, pointer);
    if (!target) {
      dropped.push(path);
      return undefined;
    }
    const { $ref: _ref, ...rest } = current;
    current = { ...target, ...rest };
  }
  let nullable = current["nullable"] === true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = current[key];
    if (!Array.isArray(branches)) continue;
    const concrete: unknown[] = [];
    for (const branch of branches) {
      const resolved = normalizeNode(branch, root, depth + 1, dropped, path);
      if (!resolved) continue;
      if (resolved["type"] === "null") {
        nullable = true;
        continue;
      }
      concrete.push(resolved);
    }
    const { [key]: _branches, ...rest } = current;
    current = rest;
    const first = concrete[0];
    if (concrete.length >= 1 && isObject(first)) current = { ...first, ...current };
  }
  const allOf = current["allOf"];
  if (Array.isArray(allOf)) {
    const { allOf: _allOf, ...rest } = current;
    let merged: JsonObject = {};
    for (const branch of allOf) {
      const resolved = normalizeNode(branch, root, depth + 1, dropped, path);
      if (resolved) merged = { ...merged, ...resolved };
    }
    current = { ...merged, ...rest };
  }
  let type = current["type"];
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === "string");
    if (names.includes("null")) nullable = true;
    type = names.find((name) => name !== "null");
  }
  if (typeof type !== "string" && current["const"] !== undefined) {
    type = inferConstType(current["const"]);
  }
  if (typeof type !== "string" && isObject(current["properties"])) type = "object";
  if (typeof type !== "string" && current["enum"] !== undefined) {
    const values = Array.isArray(current["enum"]) ? current["enum"] : [];
    type = values.every((entry) => typeof entry === "string") ? "string" : inferConstType(values[0]);
  }
  if (typeof type !== "string" || !PROFILE_TYPES.has(type)) {
    dropped.push(path);
    return undefined;
  }
  const out: JsonObject = { type };
  if (typeof current["description"] === "string") out["description"] = current["description"];
  if (nullable) out["nullable"] = true;
  if (Array.isArray(current["enum"])) out["enum"] = current["enum"];
  else if (current["const"] !== undefined) out["enum"] = [current["const"]];
  if (type === "array") {
    const items = normalizeNode(current["items"], root, depth + 1, dropped, `${path}/items`);
    if (items) out["items"] = items;
  }
  if (type === "object" && isObject(current["properties"])) {
    const { properties, required } = normalizeProperties(current, root, depth, dropped, path);
    if (Object.keys(properties).length > 0) out["properties"] = properties;
    if (required.length > 0) out["required"] = required;
  }
  return out;
}

function normalizeProperties(
  node: JsonObject,
  root: JsonObject,
  depth: number,
  dropped: string[],
  path: string,
): { properties: JsonObject; required: string[] } {
  const source = isObject(node["properties"]) ? node["properties"] : {};
  const properties: JsonObject = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = normalizeNode(value, root, depth + 1, dropped, `${path}/${name}`);
    if (normalized) properties[name] = normalized;
  }
  const declared = Array.isArray(node["required"]) ? node["required"] : [];
  const required = declared.filter(
    (name): name is string => typeof name === "string" && properties[name] !== undefined,
  );
  return { properties, required };
}

export function normalizeSchema(schema: unknown): { schema: JsonObject; dropped: string[] } {
  const dropped: string[] = [];
  if (!isObject(schema)) return { schema: { type: "object", properties: {} }, dropped };
  const root = schema;
  const normalized = normalizeNode({ ...schema, type: schema["type"] ?? "object" }, root, 0, dropped, "");
  if (!normalized || normalized["type"] !== "object") {
    return { schema: { type: "object", properties: {} }, dropped };
  }
  if (normalized["properties"] === undefined) normalized["properties"] = {};
  return { schema: normalized, dropped };
}

export function schemaOf(tool: McpTool, log: (message: string) => void = defaultLog): TSchema {
  const { schema, dropped } = normalizeSchema(tool.inputSchema);
  if (dropped.length > 0) {
    log(`xenopi mcp: dropped unsupported schema members on ${tool.name}: ${dropped.join(", ")}`);
  }
  return schema as unknown as TSchema;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function toAgentToolResult(result: unknown): AgentToolResult<unknown> {
  const record = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const content: { type: "text"; text: string }[] = [];
  if (Array.isArray(record.content)) {
    for (const item of record.content as { type?: unknown; text?: unknown }[]) {
      if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
      else content.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? {}) });
  if (record.isError === true) {
    throw new Error(content.map((item) => item.text).join("\n"));
  }
  return { content, details: record.structuredContent ?? null };
}

export interface McpSession {
  server: string;
  client: Client;
  tools: McpTool[];
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
export const CLOSE_TIMEOUT_MS = 2000;

export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function connectServer(server: string, config: McpServerConfig): Promise<McpSession> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const timeoutMs = config.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  try {
    await withTimeout(
      client.connect(createTransport(config)),
      timeoutMs,
      `MCP server ${server} did not complete its handshake in time`,
    );
    const listed = await withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP server ${server} did not list its tools in time`,
    );
    return { server, client, tools: listed.tools as McpTool[] };
  } catch (error) {
    await closeQuietly(client);
    throw error;
  }
}

export async function closeQuietly(client: Client): Promise<void> {
  try {
    await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "MCP client close timed out");
  } catch {
    return;
  }
}

export function toolDefinitions(session: McpSession): ToolDefinition[] {
  return session.tools.map((tool) => {
    const definition: ToolDefinition = {
      name: qualifiedName(session.server, tool.name),
      label: `${session.server}: ${tool.name}`,
      description: tool.description ?? `${tool.name} on the ${session.server} MCP server`,
      parameters: schemaOf(tool),
      execute: async (_toolCallId, params) => {
        const result = await session.client.callTool({
          name: tool.name,
          arguments: (params ?? {}) as Record<string, unknown>,
        });
        return toAgentToolResult(result);
      },
    };
    return definition;
  });
}

export async function loadSessions(agentDir: string): Promise<McpSession[]> {
  const config = readMcpConfig(agentDir);
  const servers = config.servers ?? {};
  const sessions: McpSession[] = [];
  for (const [server, entry] of Object.entries(servers)) {
    try {
      sessions.push(await connectServer(server, entry));
    } catch (error) {
      process.stderr.write(
        `xenopi mcp: cannot connect to ${server}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return sessions;
}

export default async function xenopiMcp(pi: ExtensionAPI): Promise<void> {
  const agentDir = resolveAgentDir();
  const sessions = await loadSessions(agentDir);
  for (const session of sessions) {
    for (const definition of toolDefinitions(session)) pi.registerTool(definition);
  }
  pi.on("session_shutdown", () => {
    for (const session of sessions) void closeQuietly(session.client);
  });
}
