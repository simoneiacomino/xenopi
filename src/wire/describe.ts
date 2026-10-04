import type { XenolithSettings } from "../config.js";
import { openConnection, type WireConnection } from "./client.js";
import { WireError, type WireDescribe } from "./protocol.js";

/** Validate the v1 handshake before using service metadata as model capabilities. */
export function parseDescription(value: Record<string, unknown>): WireDescribe {
  const invalid = (field: string): never => {
    throw new WireError("invalid_request", `invalid Xenolith describe response: ${field}`);
  };
  if (value["protocol"] !== 1) invalid("unsupported protocol version");
  if (typeof value["model"] !== "string" || !value["model"].trim()) invalid("model");
  for (const field of ["context_window", "max_output", "max_frame"] as const) {
    const number = value[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) invalid(field);
  }
  if (typeof value["kvstore"] !== "boolean") invalid("kvstore");
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

export async function describeService(settings: XenolithSettings): Promise<WireDescribe> {
  const connection = await openConnection({ settings });
  try {
    return await describeConnection(connection);
  } finally {
    connection.close();
  }
}
