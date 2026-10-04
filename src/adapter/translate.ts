import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { WireError } from "../wire/protocol.js";
import type { WireCall, WireMessage, WireToolDeclaration } from "../wire/protocol.js";

export interface TranslatedMessage {
  message: WireMessage;
  key: string;
  toolCallIds: string[];
  toolResultId: string | undefined;
}

export interface TranslatedContext {
  system: string | undefined;
  systemKey: string;
  tools: WireToolDeclaration[];
  toolsKey: string;
  messages: TranslatedMessage[];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") parts.push(item.text);
    else throw new WireError("invalid_request", "Xenolith wire protocol v1 accepts text input only");
  }
  return parts.join("");
}

export function translateTools(tools: Tool[] | undefined): WireToolDeclaration[] {
  if (!tools) return [];
  return tools.map((tool) => {
    const declaration: WireToolDeclaration = {
      name: tool.name,
      description: tool.description,
    };
    const parameters = tool.parameters as unknown;
    if (parameters && typeof parameters === "object") {
      declaration.parameters = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
    }
    return declaration;
  });
}

export function translateMessage(message: Exclude<Message, { role: "system" }>): TranslatedMessage {
  if (message.role === "user") {
    const wire: WireMessage = { role: "user", text: textOf(message.content) };
    return { message: wire, key: keyOf(wire), toolCallIds: [], toolResultId: undefined };
  }
  if (message.role === "assistant") {
    const calls: WireCall[] = [];
    const toolCallIds: string[] = [];
    const parts: string[] = [];
    const reasoning: string[] = [];
    for (const item of message.content) {
      if (item.type === "text") parts.push(item.text);
      else if (item.type === "thinking") reasoning.push(item.thinking);
      else if (item.type === "toolCall") {
        calls.push({ name: item.name, arguments: item.arguments ?? {} });
        toolCallIds.push(item.id);
      }
    }
    const wire: WireMessage = { role: "assistant", text: parts.join("") };
    if (reasoning.length > 0) wire.reasoning = reasoning.join("");
    if (calls.length > 0) wire.calls = calls;
    return { message: wire, key: keyOf(wire), toolCallIds, toolResultId: undefined };
  }
  const wire: WireMessage = {
    role: "tool",
    text: textOf(message.content),
    tool: message.toolName,
    status: message.isError ? "error" : "ok",
  };
  return { message: wire, key: keyOf(wire), toolCallIds: [], toolResultId: message.toolCallId };
}

export function keyOf(message: WireMessage): string {
  const { role, text, calls, tool, status } = message;
  return stableStringify({ role, text, calls, tool, status });
}

export function translateContext(context: Context): TranslatedContext {
  const transcript = normalizeContext(context);
  const system = getCurrentSystemPrompt(transcript.messages) || undefined;
  const tools = translateTools(getCurrentTools(transcript.messages));
  return {
    system,
    systemKey: stableStringify(system || null),
    tools,
    toolsKey: stableStringify(tools),
    // Protocol v1 carries one prompt/tool set outside the conversation. A
    // changed effective prompt or tool set triggers the adapter's rebuild.
    messages: transcript.messages.filter((message) => message.role !== "system").map(translateMessage),
  };
}

export function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index++;
  return index;
}
