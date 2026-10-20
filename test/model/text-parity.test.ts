import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { XenolithAdapter } from "../../src/adapter/adapter.js";
import { describeService } from "../../src/wire/describe.js";
import { batteryModel, disposeRoot, logPath, startService, stopAllServices, wireSettings } from "./service.js";

const baseline = process.env["XENOPI_BASELINE_DIR"];
for (const capacity of [65536, 131072]) {
  test(`text output and latency parity against pre-vision Xenopi at ${capacity}`, { skip: !baseline }, async () => {
    const service = await startService(undefined, { context: capacity });
    const samples: { variant: string; elapsed_ms: number; text: string; usage: unknown; stop: string }[] = [];
    const old = await import(pathToFileURL(join(baseline!, "dist/src/adapter/adapter.js")).href) as { XenolithAdapter: typeof XenolithAdapter };
    const settings = wireSettings(service);
    const previous = new old.XenolithAdapter({ agentDir: join(service.root, "baseline-agent"), settings });
    const candidate = new XenolithAdapter({ agentDir: join(service.root, "candidate-agent"), settings });
    try {
      const model = batteryModel(await describeService(settings));
      const context = { systemPrompt: "You are a concise assistant.", messages: [{ role: "user" as const,
        content: "List the integers from 1 to 12 in ascending order, separated by commas. Output only the list.", timestamp: 0 }] };
      const run = async (adapter: XenolithAdapter, variant: string) => {
        const start = performance.now();
        const result = await adapter.streamSimple(model, context, { temperature: 0, maxTokens: 64, cacheRetention: "none" }).result();
        assert.equal(result.errorMessage, undefined);
        return { variant, elapsed_ms: performance.now() - start,
          text: result.content.filter((c) => c.type === "text").map((c) => c.text).join(""), usage: result.usage, stop: result.stopReason };
      };
      await run(previous, "warmup"); await run(candidate, "warmup");
      for (const variant of ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate", "candidate", "baseline"]) {
        samples.push(await run(variant === "baseline" ? previous : candidate, variant));
      }
      for (const sample of samples) {
        assert.equal(sample.text, samples[0]!.text);
        assert.equal(sample.stop, samples[0]!.stop);
        assert.deepEqual(sample.usage, samples[0]!.usage);
      }
    } finally {
      previous.close(); candidate.close();
      writeFileSync(logPath(`text-parity-${capacity}.json`), JSON.stringify({ capacity, baseline, samples }, null, 2));
      await stopAllServices(); disposeRoot(service);
    }
  });
}
