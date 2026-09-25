import type { Api, Model, Context, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { XenolithAdapter } from "../adapter/adapter.js";
import { translateContext } from "../adapter/translate.js";
import { resolveAgentDir } from "../config.js";
import {
  CONTEXT_WINDOW,
  MAX_OUTPUT,
  MODEL_ID,
  PROVIDER_API,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
} from "../product.js";

export {
  CONTEXT_WINDOW,
  MAX_OUTPUT,
  MODEL_ID,
  PROVIDER_API,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
};

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export function summaryMaxTokens(reserveTokens: number, modelMaxTokens: number): number {
  const reserve = Math.floor(0.8 * reserveTokens);
  const limit = modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY;
  const budget = Math.min(reserve, limit);
  return Number.isFinite(budget) && budget > 0 ? budget : 1024;
}

export function compactionPrefixKeys(messages: AgentMessage[]): string[] {
  const llm: Message[] = convertToLlm(messages);
  return translateContext({ messages: llm }).messages.map((entry) => entry.key);
}

export function buildSummaryPrompt(previousSummary?: string, customInstructions?: string): string {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  if (!previousSummary) return basePrompt;
  return `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${basePrompt}`;
}

export function providerModel(): {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap: { minimal: null; xhigh: null; max: "max" };
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
} {
  return {
    id: MODEL_ID,
    name: "Gemma 4 26B A4B (xenolith)",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: null, max: "max" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT,
  };
}

export function createAdapter(env: NodeJS.ProcessEnv = process.env): XenolithAdapter {
  return new XenolithAdapter({ agentDir: resolveAgentDir(env), env });
}

const liveAdapters = new Set<XenolithAdapter>();

export function activeAdapters(): XenolithAdapter[] {
  return [...liveAdapters];
}

export default function xenolithProvider(pi: ExtensionAPI): void {
  const adapter = createAdapter();
  liveAdapters.add(adapter);

  const streamSimple = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    void options?.onPayload?.({ provider: PROVIDER_ID, model: model.id }, model);
    return adapter.streamSimple(model, context, options);
  };

  pi.registerProvider(PROVIDER_ID, {
    name: "Xenolith",
    baseUrl: PROVIDER_BASE_URL,
    apiKey: "xenolith-wire",
    api: PROVIDER_API,
    streamSimple,
    models: [providerModel()],
  });

  pi.on("session_start", (_event, ctx) => {
    adapter.setNoticeSink((message, level) => ctx.ui.notify(`xenopi: ${message}`, level));
    void guard(async () => {
      await adapter.sweep(ctx.sessionManager.getSessionDir());
    });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    return guard(async () => {
      const piSession = ctx.sessionManager.getSessionId();
      const model = ctx.model;
      if (!piSession || !model || model.provider !== PROVIDER_ID) return undefined;
      const expected = compactionPrefixKeys(event.preparation.messagesToSummarize);
      if (expected.length === 0) return undefined;
      const prompt = buildSummaryPrompt(event.preparation.previousSummary, event.customInstructions);
      const summary = await adapter.summarize(
        piSession,
        prompt,
        { max_tokens: summaryMaxTokens(event.preparation.settings.reserveTokens, model.maxTokens) },
        model,
        event.signal,
        expected,
      );
      if (!summary || summary.text.trim().length === 0) return undefined;
      return {
        compaction: {
          summary: summary.text,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: summary.usage,
        },
      };
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    void guard(async () => {
      const piSession = ctx.sessionManager.getSessionId();
      if (piSession) adapter.markDirty(piSession);
    });
  });

  pi.on("session_before_tree", (_event, ctx) => {
    void guard(async () => {
      const piSession = ctx.sessionManager.getSessionId();
      if (piSession) await adapter.checkpoint(piSession);
    });
    return undefined;
  });

  pi.on("session_shutdown", () => {
    void guard(async () => {
      adapter.close();
    });
  });
}

async function guard<T>(body: () => Promise<T>): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    process.stderr.write(`xenopi hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}
