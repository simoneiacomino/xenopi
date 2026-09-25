import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultAgentDir, resolveAgentDir } from "../../src/config.js";
import {
  extensionPaths,
  isOwnExtensionPath,
  packageRoot,
  prepareLaunch,
  projectOverrideWarning,
  resolvePiCli,
  resolvePiPackageRoot,
  seedBrandingPackage,
  seedAgentDir,
} from "../../src/launcher.js";
import { MODEL_ID, PROVIDER_ID } from "../../src/product.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "xenopi-home-"));
}

test("the agent dir defaults under the home directory and honours XENOPI_DIR", () => {
  const home = tempHome();
  try {
    assert.equal(defaultAgentDir({ HOME: home }), join(home, ".xenopi", "agent"));
    assert.equal(defaultAgentDir({ HOME: home, XENOPI_DIR: "/tmp/custom" }), "/tmp/custom");
    assert.equal(resolveAgentDir({ HOME: home, PI_CODING_AGENT_DIR: "/tmp/managed" }), "/tmp/managed");
    assert.equal(
      resolveAgentDir({ HOME: home, XENOPI_CODING_AGENT_DIR: "/tmp/branded" }),
      "/tmp/branded",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepareLaunch seeds an isolated branded agent dir", () => {
  const home = tempHome();
  try {
    const plan = prepareLaunch({ HOME: home, PATH: process.env["PATH"] ?? "" });

    assert.equal(plan.agentDir, join(home, ".xenopi", "agent"));
    assert.equal(plan.env["PI_CODING_AGENT_DIR"], plan.agentDir);
    assert.equal(plan.env["XENOPI_CODING_AGENT_DIR"], plan.agentDir);
    assert.equal(plan.env["PI_PACKAGE_DIR"], plan.brandingPackageDir);
    assert.equal(plan.env["PI_SKIP_VERSION_CHECK"], "1");
    assert.equal(existsSync(join(plan.agentDir, "sessions")), true);
    assert.equal(plan.settingsPath, join(plan.agentDir, "settings.json"));

    const settings = JSON.parse(readFileSync(plan.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(settings["defaultProvider"], PROVIDER_ID);
    assert.equal(settings["defaultModel"], MODEL_ID);
    assert.deepEqual(settings["extensions"], extensionPaths());
    for (const path of extensionPaths()) {
      assert.match(path, /dist\/src\/extensions\/(branding|provider|mcp)\.js$/);
    }
    assert.equal(plan.cliPath, resolvePiCli());
    assert.equal(existsSync(plan.cliPath), true);
    assert.equal(existsSync(join(home, ".pi")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the runtime package overlay activates pi's native XenoPi branding", () => {
  const home = tempHome();
  try {
    const agentDir = join(home, ".xenopi", "agent");
    const overlay = seedBrandingPackage(agentDir, resolvePiPackageRoot());
    const manifest = JSON.parse(readFileSync(join(overlay, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(manifest["name"], "xenopi");
    assert.deepEqual(manifest["piConfig"], { name: "xenopi", configDir: ".xenopi" });
    assert.equal(existsSync(join(overlay, "dist", "modes", "interactive", "theme", "dark.json")), true);
    assert.equal(existsSync(join(overlay, "docs")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the launched CLI identifies itself as xenopi", () => {
  const home = tempHome();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XENOPI_DIR: join(home, ".xenopi", "agent"),
    };
    delete env["NODE_TEST_CONTEXT"];
    const result = spawnSync(
      process.execPath,
      [join(packageRoot(), "dist", "src", "bin", "xenopi.js"), "--help"],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.equal(result.error, undefined, result.error?.message ?? "failed to launch xenopi");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^xenopi - AI coding assistant/m);
    assert.match(result.stdout, /^  xenopi \[options\]/m);
    assert.doesNotMatch(result.stdout, /^pi - AI coding assistant/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("re-seeding refreshes this package's extension paths and keeps every other entry", () => {
  const home = tempHome();
  try {
    const agentDir = join(home, ".xenopi", "agent");
    const plan = prepareLaunch({ HOME: home });
    const settings = JSON.parse(readFileSync(plan.settingsPath, "utf8")) as Record<string, unknown>;
    settings["extensions"] = [
      ...extensionPaths(),
      "/opt/other-package/dist/src/extensions/provider.js",
      "/home/user/my-extension.ts",
    ];
    settings["theme"] = "dark";
    writeFileSync(plan.settingsPath, JSON.stringify(settings, null, 2));

    seedAgentDir(agentDir, extensionPaths());

    const refreshed = JSON.parse(readFileSync(plan.settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(refreshed["extensions"], [
      ...extensionPaths(),
      "/opt/other-package/dist/src/extensions/provider.js",
      "/home/user/my-extension.ts",
    ]);
    assert.equal(refreshed["theme"], "dark");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("only this package's own extension paths are recognised for replacement", () => {
  const root = packageRoot();
  for (const path of extensionPaths(root)) assert.equal(isOwnExtensionPath(path, root), true);
  assert.equal(isOwnExtensionPath("/opt/other/dist/src/extensions/provider.js", root), false);
  assert.equal(isOwnExtensionPath("/home/user/my-extension.ts", root), false);
  assert.equal(isOwnExtensionPath(`${root}-sibling/dist/src/extensions/provider.js`, root), false);
});

test("seeding does not revert a user's model choice on relaunch", () => {
  const home = tempHome();
  try {
    const agentDir = join(home, ".xenopi", "agent");
    const plan = prepareLaunch({ HOME: home });
    const settings = JSON.parse(readFileSync(plan.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(settings["defaultProvider"], PROVIDER_ID);
    settings["defaultProvider"] = "anthropic";
    settings["defaultModel"] = "claude-sonnet-4-5";
    writeFileSync(plan.settingsPath, JSON.stringify(settings, null, 2));

    seedAgentDir(agentDir, extensionPaths());

    const refreshed = JSON.parse(readFileSync(plan.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(refreshed["defaultProvider"], "anthropic");
    assert.equal(refreshed["defaultModel"], "claude-sonnet-4-5");
    assert.deepEqual(refreshed["extensions"], extensionPaths());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the packaged extension entry points exist on disk", () => {
  for (const path of extensionPaths(packageRoot())) {
    assert.equal(existsSync(path), true, `missing built extension ${path}`);
  }
});

test("a project-scope settings file that overrides provider wiring is flagged before boot", () => {
  const project = mkdtempSync(join(tmpdir(), "xenopi-project-"));
  try {
    assert.equal(projectOverrideWarning(project), undefined);
    mkdirSync(join(project, ".xenopi"), { recursive: true });
    writeFileSync(join(project, ".xenopi", "settings.json"), JSON.stringify({ theme: "dark" }));
    assert.equal(projectOverrideWarning(project), undefined);
    writeFileSync(
      join(project, ".xenopi", "settings.json"),
      JSON.stringify({ extensions: ["./x.ts"], defaultProvider: "anthropic" }),
    );
    const warning = projectOverrideWarning(project);
    assert.match(warning ?? "", /overrides extensions, defaultProvider/);
    assert.match(warning ?? "", /xenolith provider may not be active/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
