import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveXenolithSettings } from "../../src/config.js";

test("context defaults to the engine and the environment overrides the config file", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "xenopi-context-config-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  assert.equal(resolveXenolithSettings(agentDir, {}).context, undefined);
  writeFileSync(join(agentDir, "xenolith.json"), JSON.stringify({ context: 4097 }));
  assert.equal(resolveXenolithSettings(agentDir, {}).context, 4097);
  assert.equal(resolveXenolithSettings(agentDir, { XENOLITH_CONTEXT: "32768" }).context, 32768);
  // Only the effective setting is validated when an override exists.
  writeFileSync(join(agentDir, "xenolith.json"), JSON.stringify({ context: -1 }));
  assert.equal(resolveXenolithSettings(agentDir, { XENOLITH_CONTEXT: "32768" }).context, 32768);
});

test("context settings do not assume a model's minimum or maximum", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "xenopi-context-range-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  for (const context of [1, 63, 4097, 300000, Number.MAX_SAFE_INTEGER]) {
    writeFileSync(join(agentDir, "xenolith.json"), JSON.stringify({ context }));
    assert.equal(resolveXenolithSettings(agentDir, {}).context, context);
    assert.equal(resolveXenolithSettings(agentDir, { XENOLITH_CONTEXT: String(context) }).context, context);
  }
});

test("invalid context values fail explicitly instead of using a default", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "xenopi-context-invalid-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  for (const context of [0, -1, 1.5, null, true, "4097", {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    writeFileSync(join(agentDir, "xenolith.json"), JSON.stringify({ context }));
    assert.throws(() => resolveXenolithSettings(agentDir, {}), /"context" in xenolith.json must be a positive safe integer/);
  }
  writeFileSync(join(agentDir, "xenolith.json"), JSON.stringify({ context: 4097 }));
  for (const context of ["", "0", "-1", "+1", "1.5", " 4097", "4097 ", "1e3", "NaN", "Infinity", "9007199254740992"]) {
    assert.throws(() => resolveXenolithSettings(agentDir, { XENOLITH_CONTEXT: context }), /XENOLITH_CONTEXT must be a positive safe integer/);
  }
});
