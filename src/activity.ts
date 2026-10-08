import type { WireEvent } from "./wire/protocol.js";

export type ConnectionPhase = "connecting" | "starting" | "ready";

export type ActivityUpdate =
  | { type: "begin" }
  | { type: "phase"; phase: Exclude<ConnectionPhase, "ready"> | "preparing" }
  | { type: "event"; event: WireEvent }
  | { type: "end" };

export type ActivityReporter = (update: ActivityUpdate) => void;
export type ActivitySink = (id: number, update: ActivityUpdate) => void;
