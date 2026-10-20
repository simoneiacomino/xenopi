import type { XenolithSettings } from "../config.js";
import type { ConnectionPhase } from "../activity.js";
import { openConnection, type WireConnection } from "./client.js";
import { WireError, type WireDescribe } from "./protocol.js";

/** Validate capabilities before registering the text or multimodal provider. */
export function parseDescription(value: Record<string, unknown>): WireDescribe {
  const invalid = (field: string): never => {
    throw new WireError("invalid_request", `invalid Xenolith describe response: ${field}`);
  };
  if (value["protocol"] !== 1 && value["protocol"] !== 2) invalid("unsupported protocol version");
  if (typeof value["model"] !== "string" || !value["model"].trim()) invalid("model");
  for (const field of ["context_window", "max_output", "max_frame"] as const) {
    const number = value[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) invalid(field);
  }
  if (typeof value["kvstore"] !== "boolean") invalid("kvstore");
  const vision = value["vision"] as Partial<NonNullable<WireDescribe["vision"]>> | undefined;
  if (value["protocol"] === 2) {
    const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    if (!vision || typeof vision !== "object" ||
        !Array.isArray(vision.formats) || !vision.formats.length ||
        !vision.formats.every((format) => format === "png" || format === "jpeg") ||
        !Array.isArray(vision.budgets) || !vision.budgets.length || !vision.budgets.every(positive) ||
        !positive(vision.default_budget) || !vision.budgets.includes(vision.default_budget) ||
        !positive(vision.max_bytes) || !positive(vision.max_context_media_bytes) ||
        vision.max_context_media_bytes < vision.max_bytes || typeof vision.media_refs !== "boolean") invalid("vision");
  } else if (vision !== undefined) invalid("vision requires protocol v2");
  const reasoning = value["reasoning"] as Partial<WireDescribe["reasoning"]> | undefined;
  if (!reasoning || typeof reasoning !== "object" ||
      !Array.isArray(reasoning.efforts) ||
      !reasoning.efforts.every((effort) => ["low", "medium", "high", "max"].includes(effort)) ||
      !Array.isArray(reasoning.history) ||
      !reasoning.history.every((history) => ["discard", "preserve_tool_calls"].includes(history)) ||
      typeof reasoning.budget_tokens !== "boolean") invalid("reasoning");
  return value as unknown as WireDescribe;
}

export async function describeConnection(connection: WireConnection): Promise<WireDescribe> {
  const timer = setTimeout(() => connection.close(), 10000);
  try {
    const info = parseDescription(await connection.request({ op: "describe" }));
    connection.maxFrameBytes = info.max_frame;
    return info;
  } finally {
    clearTimeout(timer);
  }
}

export async function describeService(
  settings: XenolithSettings,
  onStatus?: (phase: ConnectionPhase) => void,
): Promise<WireDescribe> {
  const connection = await openConnection({ settings, onStatus });
  try {
    return await describeConnection(connection);
  } finally {
    connection.close();
  }
}
