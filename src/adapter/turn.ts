import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Api,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { WireStop, WireUsage } from "../wire/protocol.js";
import type { WireCall, WireMessage } from "../wire/protocol.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { ...ZERO_COST },
  };
}

export function mapUsage(usage: WireUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cache_read,
    cacheWrite: 0,
    reasoning: usage.reasoning,
    totalTokens: usage.total,
    cost: { ...ZERO_COST },
  };
}

export function mapStop(stop: WireStop): Extract<StopReason, "stop" | "length" | "toolUse"> {
  if (stop === "tool_use") return "toolUse";
  if (stop === "length") return "length";
  return "stop";
}

export class TurnBuilder {
  readonly message: AssistantMessage;
  private textIndex = -1;
  private textBuffer = "";
  private thinkingIndex = -1;
  private thinkingBuffer = "";
  private readonly calls: WireCall[] = [];
  private readonly callIds: number[] = [];

  constructor(
    private readonly stream: AssistantMessageEventStream,
    model: Model<Api>,
  ) {
    this.message = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  start(): void {
    this.stream.push({ type: "start", partial: this.message });
  }

  textDelta(text: string): void {
    if (text.length === 0) return;
    this.closeThinking();
    if (this.textIndex < 0) {
      this.textIndex = this.message.content.length;
      this.message.content.push({ type: "text", text: "" } satisfies TextContent);
      this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.message });
    }
    this.textBuffer += text;
    const block = this.message.content[this.textIndex];
    if (block && block.type === "text") block.text = this.textBuffer;
    this.stream.push({
      type: "text_delta",
      contentIndex: this.textIndex,
      delta: text,
      partial: this.message,
    });
  }

  reasoningDelta(text: string): void {
    if (text.length === 0) return;
    this.closeText();
    if (this.thinkingIndex < 0) {
      this.thinkingIndex = this.message.content.length;
      this.message.content.push({ type: "thinking", thinking: "" } satisfies ThinkingContent);
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.message });
    }
    this.thinkingBuffer += text;
    const block = this.message.content[this.thinkingIndex];
    if (block && block.type === "thinking") block.thinking = this.thinkingBuffer;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingIndex,
      delta: text,
      partial: this.message,
    });
  }

  private closeThinking(): void {
    if (this.thinkingIndex < 0) return;
    this.stream.push({
      type: "thinking_end",
      contentIndex: this.thinkingIndex,
      content: this.thinkingBuffer,
      partial: this.message,
    });
    this.thinkingIndex = -1;
  }

  private closeText(): void {
    if (this.textIndex < 0) return;
    this.stream.push({
      type: "text_end",
      contentIndex: this.textIndex,
      content: this.textBuffer,
      partial: this.message,
    });
    this.textIndex = -1;
  }

  toolCallStart(): void {
    this.closeThinking();
    this.closeText();
    this.stream.push({
      type: "toolcall_start",
      contentIndex: this.message.content.length,
      partial: this.message,
    });
  }

  toolCallEnd(id: number, name: string, args: Record<string, unknown>): void {
    const toolCall: ToolCall = {
      type: "toolCall",
      id: String(id),
      name,
      arguments: args,
    };
    const contentIndex = this.message.content.length;
    this.message.content.push(toolCall);
    this.calls.push({ name, arguments: args });
    this.callIds.push(id);
    this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.message });
  }

  done(stop: WireStop, usage: WireUsage): void {
    this.closeThinking();
    this.closeText();
    this.message.usage = mapUsage(usage);
    this.message.rawStopReason = stop;
    const reason = mapStop(stop);
    this.message.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.message });
    this.stream.end(this.message);
  }

  fail(reason: "error" | "aborted", errorMessage: string, usage?: WireUsage): void {
    this.closeThinking();
    this.closeText();
    if (usage) this.message.usage = mapUsage(usage);
    this.message.stopReason = reason;
    this.message.errorMessage = errorMessage;
    this.stream.push({ type: "error", reason, error: this.message });
    this.stream.end(this.message);
  }

  get text(): string {
    const parts: string[] = [];
    for (const block of this.message.content) {
      if (block.type === "text") parts.push(block.text);
    }
    return parts.join("");
  }

  get wireMessage(): WireMessage {
    const wire: WireMessage = { role: "assistant", text: this.text };
    if (this.thinkingBuffer.length > 0) wire.reasoning = this.thinkingBuffer;
    if (this.calls.length > 0) wire.calls = this.calls.map((call) => ({ ...call }));
    return wire;
  }

  get wireCallIds(): number[] {
    return [...this.callIds];
  }
}
