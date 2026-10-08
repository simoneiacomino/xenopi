import type { ActivitySink } from "./activity.js";
import type { WireEvent, WireInferenceMeasurement } from "./wire/protocol.js";

type Phase = "connecting" | "starting" | "preparing" | "prefill" | "decode" | "finalizing";

interface Sample {
  tokens: number;
  elapsed_ms: number;
}

/** Presentation only: token counters and active phase times come from Xenolith. */
export class InferenceDisplay {
  private id: number | undefined;
  private phase: Phase = "preparing";
  private started = 0;
  private prefillStarted = 0;
  private measured = false;
  private lifecycle = false;
  private inferencePhase: "prefill" | "decode" | undefined;
  private phaseFinished = false;
  private tokens = 0;
  private total: number | undefined;
  private elapsed = 0;
  private rate: number | undefined;
  private samples: Sample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastLine: string | undefined;

  constructor(
    private readonly publish: (line: string | undefined) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  readonly update: ActivitySink = (id, update) => {
    if (update.type === "begin") {
      this.clear();
      this.id = id;
      this.measured = false;
      this.lifecycle = false;
      this.inferencePhase = undefined;
      this.phaseFinished = false;
      this.setPhase("preparing");
      this.prefillStarted = this.now();
      this.timer = setInterval(() => this.render(), 100);
      this.timer.unref();
    } else if (this.id !== id) {
      return;
    } else if (update.type === "end") {
      this.clear();
      return;
    } else if (update.type === "phase") {
      this.setPhase(update.phase);
    } else {
      this.event(update.event);
    }
    this.render();
  };

  clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.id = undefined;
    if (this.lastLine !== undefined) this.publish(undefined);
    this.lastLine = undefined;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.started = this.now();
    this.tokens = 0;
    this.total = undefined;
    this.elapsed = 0;
    this.rate = undefined;
    this.samples = [{ tokens: 0, elapsed_ms: 0 }];
  }

  private sample(sample: WireInferenceMeasurement): boolean {
    const previous = this.samples[this.samples.length - 1];
    if (previous && (sample.tokens < previous.tokens || sample.elapsed_ms < previous.elapsed_ms)) return false;
    this.tokens = sample.tokens;
    this.elapsed = sample.elapsed_ms;
    this.samples.push({ tokens: sample.tokens, elapsed_ms: sample.elapsed_ms });
    while (this.samples.length > 2 && this.samples[1]!.elapsed_ms <= sample.elapsed_ms - 2000) {
      this.samples.shift();
    }
    const first = this.samples[0]!;
    const duration = sample.elapsed_ms - first.elapsed_ms;
    this.rate = duration > 0 ? (sample.tokens - first.tokens) * 1000 / duration : undefined;
    return true;
  }

  private event(event: WireEvent): void {
    switch (event.event) {
      case "start":
        if (this.phase !== "preparing") this.setPhase("preparing");
        this.prefillStarted = this.now();
        break;
      case "inference_progress":
        if ((event.phase !== "prefill" && event.phase !== "decode") || !validMeasurement(event) ||
            (event.state !== undefined && event.state !== "running" && event.state !== "finished") ||
            (event.phase === "prefill" && (!Number.isSafeInteger(event.total) || event.total < event.tokens))) return;
        if (this.inferencePhase === "decode" && event.phase === "prefill") return;
        if (this.inferencePhase === event.phase && this.phaseFinished) return;
        if (this.inferencePhase !== event.phase) {
          this.setPhase(event.phase);
          this.inferencePhase = event.phase;
          this.phaseFinished = false;
        }
        this.measured = true;
        if (!this.sample(event)) return;
        this.total = event.phase === "prefill" ? event.total : undefined;
        if (event.state !== undefined) this.lifecycle = true;
        if (event.state === "finished") {
          this.phaseFinished = true;
          // Stop displaying the phase's local clock. The next phase starts its
          // own clock; no success or next phase is inferred from these counts.
          this.phase = event.phase === "prefill" ? "preparing" : "finalizing";
          this.started = this.now();
        }
        break;
      case "progress":
        if (this.measured || !Number.isSafeInteger(event.prefilled) || event.prefilled < 0 ||
            !Number.isSafeInteger(event.total) || event.total < event.prefilled) return;
        if (this.phase !== "prefill") this.setPhase("prefill");
        if (this.sample({ tokens: event.prefilled, elapsed_ms: this.now() - this.prefillStarted })) this.total = event.total;
        break;
      case "text_delta":
      case "reasoning_delta":
      case "toolcall_start":
      case "toolcall_end":
        if (this.lifecycle && (this.inferencePhase !== "decode" || this.phaseFinished)) return;
        if (this.phase !== "decode") this.setPhase("decode");
        break;
      case "done":
      case "error":
        this.clear();
        break;
    }
  }

  private render(): void {
    if (this.id === undefined) return;
    const elapsed = (this.now() - this.started) / 1000;
    let line: string;
    if (this.phase === "prefill") {
      const total = this.total ?? 0;
      const fraction = total > 0 ? Math.min(1, this.tokens / total) : 1;
      const cells = Math.floor(fraction * 10);
      const bar = "█".repeat(cells) + "░".repeat(10 - cells);
      const rate = this.elapsed > 0 ? this.tokens * 1000 / this.elapsed : undefined;
      line = `Prefill ${bar} ${Math.floor(fraction * 100)}% · ${this.tokens}/${total} tok${speed(rate, !this.measured)}`;
    } else if (this.phase === "decode") {
      const count = this.measured ? ` · ${this.tokens} tok` : "";
      line = `Generating${count}${this.measured ? speed(this.rate, false) : ""} · ${elapsed.toFixed(1)} s`;
    } else {
      const label = this.phase === "starting" ? "Starting Xenolith" :
        this.phase === "connecting" ? "Connecting to Xenolith" :
        this.phase === "finalizing" ? "Finalizing" :
        this.phaseFinished ? "Preparing" : "Preparing prompt";
      line = `${label}… ${elapsed.toFixed(1)} s`;
    }
    if (line !== this.lastLine) {
      this.lastLine = line;
      this.publish(line);
    }
  }
}

function validMeasurement(sample: WireInferenceMeasurement): boolean {
  return Number.isSafeInteger(sample.tokens) && sample.tokens >= 0 &&
    Number.isFinite(sample.elapsed_ms) && sample.elapsed_ms >= 0;
}

function speed(rate: number | undefined, estimated: boolean): string {
  return rate !== undefined && Number.isFinite(rate) && rate > 0
    ? ` · ${estimated ? "≈" : ""}${rate.toFixed(1)} tok/s` : "";
}
