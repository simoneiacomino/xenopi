/** Real npm installation smoke, isolated from the user's prefix and settings.
 * Run after npm ci. No engine/model is used. npm pack rebuilds this checkout.
 * Optional: XENOPI_INSTALL_TEST_DIR (empty), XENOPI_TEST_NPM_CACHE (copied),
 * XENOPI_NPM_OFFLINE=1 (bundled archives need no cache). Evidence is retained.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(Number(process.versions.node.split(".")[0]) >= 26, "Node >=26 is required");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = process.env.XENOPI_INSTALL_TEST_DIR
  ? resolve(process.env.XENOPI_INSTALL_TEST_DIR) : mkdtempSync(join(tmpdir(), "xenopi npm install "));
mkdirSync(work, { recursive: true });
assert.equal(readdirSync(work).length, 0, "Use an empty test directory to preserve previous evidence");
const cache = join(work, "npm cache");
if (process.env.XENOPI_TEST_NPM_CACHE) {
  cpSync(join(resolve(process.env.XENOPI_TEST_NPM_CACHE), "_cacache"), join(cache, "_cacache"), { recursive: true });
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(XENOLITH_|XENOPI_|PI_|XDG_|npm_|NPM_)/.test(key)));
const home = join(work, "user home");
mkdirSync(home);
const npmrc = join(work, "empty.npmrc");
writeFileSync(npmrc, "");
Object.assign(env, { HOME: home, npm_config_cache: cache, npm_config_userconfig: npmrc,
  npm_config_globalconfig: join(work, "empty-global.npmrc"), npm_config_update_notifier: "false" });
const offline = process.env.XENOPI_NPM_OFFLINE === "1" ? ["--offline"] : [];
const options = ["--ignore-scripts", "--no-audit", "--no-fund", ...offline];
const report = { node: process.version, work, offline: offline.length > 0, steps: [], status: "running" };
function save() { writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2) + "\n"); }
function run(name, command, args, cwd = repo, overrides = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8",
    timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(work, `${name}.stdout`), result.stdout ?? "");
  writeFileSync(join(work, `${name}.stderr`), result.stderr ?? "");
  report.steps.push({ name, command, args, status: result.status });
  save();
  assert.equal(result.error, undefined, result.error?.message ?? `${name}: spawn failed`);
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return result.stdout;
}
function metadata(prefix, label) {
  const packageRoot = realpathSync(join(prefix, "lib/node_modules/xenopi"));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json")));
  assert.equal(manifest.name, "xenopi");
  assert.deepEqual(manifest.piConfig, { name: "xenopi", configDir: ".xenopi" });
  assert.equal(manifest.bin.xenopi, "dist/src/bin/xenopi.js");
  assert.equal(manifest.xenolith.nativeConfig, 1, "Native config capability must survive installation");
  for (const file of [manifest.bin.xenopi, "dist/src/extensions/provider.js",
    "dist/src/wire/discovery.js", "dist/src/wire/client.js"]) {
    assert.ok(existsSync(join(packageRoot, file)), `Missing native integration artifact: ${file}`);
  }
  assert.equal(realpathSync(join(prefix, "bin/xenopi")), join(packageRoot, manifest.bin.xenopi));
  report[`${label}_identity`] = { packageRoot, version: manifest.version, xenolith: manifest.xenolith };
  const marker = join(work, `${label}-engine-invoked`);
  const engine = join(work, `${label}-fake-engine`);
  writeFileSync(engine, '#!/bin/sh\nprintf called > "$ENGINE_CALL_MARKER"\nexit 42\n');
  chmodSync(engine, 0o755);
  const agentHome = join(work, `${label} user home`);
  mkdirSync(agentHome);
  const overrides = { HOME: agentHome, PATH: join(prefix, "bin") + ":" + env.PATH,
    XENOLITH_BIN: engine, XENOLITH_CONFIG: join(agentHome, "unused-native.json"), ENGINE_CALL_MARKER: marker };
  // Resolve the ordinary command through PATH, not node dist/... or an absolute bin.
  const help = run(`${label}-help`, "xenopi", ["--help"], work, overrides);
  assert.match(help, /^xenopi - AI coding assistant/m);
  assert.match(help, /^  xenopi \[options\]/m);
  const version = run(`${label}-version`, "xenopi", ["--version"], work, overrides);
  assert.equal(version.trim(), JSON.parse(readFileSync(join(repo, "package.json"))).version);
  assert.equal(existsSync(marker), false, "help/version must not invoke the engine");
  const runtime = join(agentHome, ".xenopi/agent/runtime-package");
  assert.ok(existsSync(join(runtime, "dist/modes/interactive/theme/dark.json")), "Pi themes are available");
  assert.ok(existsSync(join(runtime, "docs/mcp.md")), "Pi runtime docs are available");
}

try {
  run("npm-build", "npm", ["run", "build"]);
  const linked = join(work, "linked prefix");
  run("npm-link", "npm", ["link", ...options], repo, { npm_config_prefix: linked });
  assert.equal(realpathSync(join(linked, "lib/node_modules/xenopi")), realpathSync(repo));
  assert.equal(realpathSync(join(linked, "bin/xenopi")), join(realpathSync(repo), "dist/src/bin/xenopi.js"));
  metadata(linked, "linked");
  const artifacts = join(work, "archives");
  mkdirSync(artifacts);
  // Normal npm pack intentionally runs prepack/build, using installed dev tools.
  const packOutput = JSON.parse(run("npm-pack", "npm", ["pack", "--json", "--pack-destination", artifacts, ...offline]));
  // npm 12 keys JSON output by package name; earlier npm emits an array.
  const packed = Array.isArray(packOutput) ? packOutput[0] : packOutput.xenopi;
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const file of ["package.json", "README.md", "LICENSE.md",
    "dist/src/bin/xenopi.js", "dist/src/extensions/provider.js", "dist/src/extensions/branding.js"]) {
    assert.ok(files.has(file), `Missing packed asset: ${file}`);
  }
  assert.ok([...files].every((file) => !file.startsWith("dist/test/") && !file.startsWith("node_modules/typescript/")));
  assert.ok(!files.has("VISION.md") && ![...files].some((file) => file.startsWith("validation/")),
    "Internal execution reports must not be included in the package");
  assert.ok(files.has("node_modules/@earendil-works/pi-coding-agent/package.json"), "Production Pi is bundled");
  const installed = join(work, "installed prefix");
  run("npm-install-tarball", "npm", ["install", "--global", "--prefix", installed,
    ...options, join(artifacts, packed.filename)], work);
  assert.equal(lstatSync(join(installed, "lib/node_modules/xenopi")).isSymbolicLink(), false);
  assert.ok(realpathSync(join(installed, "bin/xenopi")).startsWith(installed + "/"));
  metadata(installed, "packed");
  const packedApp = join(installed, "lib/node_modules/xenopi");
  assert.ok(!existsSync(join(packedApp, "node_modules/typescript")), "Global tarball install excludes dev tooling");
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json")));
  for (const name of ["chord", "pi-agent-core", "pi-ai", "pi-codemode", "pi-coding-agent", "pi-mcp", "pi-telemetry", "pi-tui"]) {
    const dependency = `node_modules/@earendil-works/${name}`;
    const version = JSON.parse(readFileSync(join(packedApp, dependency, "package.json"))).version;
    assert.equal(version, lock.packages[dependency].version, `Installed ${name} must match the locked source tree`);
  }
  report.archive_bytes = packed.size;
  report.packed_files = [...files];
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  save();
  console.log(`Installation evidence: ${join(work, "report.json")}`);
}
