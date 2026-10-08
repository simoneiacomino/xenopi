import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultAgentDir,
  resolveXenolithSettings,
  PI_AGENT_DIR_ENV,
  XENOPI_AGENT_DIR_ENV,
} from "./config.js";
import { PROVIDER_ID } from "./product.js";
import { describeService } from "./wire/describe.js";
import { migrateMcpConfig } from "./migrate-mcp.js";
import { withStartupDisplay } from "./startup.js";

const PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";

export interface LaunchPlan {
  agentDir: string;
  settingsPath: string;
  brandingPackageDir: string;
  extensionPaths: string[];
  cliPath: string;
  env: NodeJS.ProcessEnv;
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function extensionPaths(root: string = packageRoot()): string[] {
  return [
    join(root, "dist", "src", "extensions", "branding.js"),
    join(root, "dist", "src", "extensions", "provider.js"),
  ];
}

export function resolvePiCli(): string {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(entry), "cli.js");
}

export function resolvePiPackageRoot(cliPath: string = resolvePiCli()): string {
  return resolve(dirname(cliPath), "..");
}

function ensureDirectoryLink(source: string, destination: string): void {
  if (existsSync(destination) || lstatExists(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) {
      throw new Error(`xenopi: refusing to replace non-link runtime asset ${destination}`);
    }
    const current = resolve(dirname(destination), readlinkSync(destination));
    if (current === resolve(source)) return;
    unlinkSync(destination);
  }
  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * pi reads branding and bundled asset locations from one package directory.
 * XenoPi is a wrapper rather than a fork, so provide a tiny branded package
 * overlay while linking the actual UI assets and documentation from pi.
 */
export function seedBrandingPackage(
  agentDir: string,
  piPackageRoot: string = resolvePiPackageRoot(),
): string {
  const destination = join(agentDir, "runtime-package");
  mkdirSync(destination, { recursive: true });
  writeAtomic(
    join(destination, "package.json"),
    readFileSync(join(packageRoot(), "package.json"), "utf8"),
  );
  ensureDirectoryLink(join(piPackageRoot, "dist"), join(destination, "dist"));
  ensureDirectoryLink(join(piPackageRoot, "docs"), join(destination, "docs"));
  ensureDirectoryLink(join(piPackageRoot, "examples"), join(destination, "examples"));
  for (const file of ["README.md", "CHANGELOG.md"]) {
    const source = join(piPackageRoot, file);
    if (existsSync(source)) copyFileSync(source, join(destination, file));
  }
  return destination;
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAtomic(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isOwnExtensionPath(entry: string, root: string): boolean {
  const prefix = `${normalizeSeparators(resolve(root, "dist", "src", "extensions"))}/`;
  return normalizeSeparators(resolve(entry)).startsWith(prefix);
}

export function seedAgentDir(agentDir: string, paths: string[], root: string = packageRoot()): string {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const settings = readSettings(settingsPath);
  const configured = Array.isArray(settings["extensions"]) ? (settings["extensions"] as unknown[]) : [];
  const kept = configured.filter(
    (entry): entry is string => typeof entry === "string" && !isOwnExtensionPath(entry, root),
  );
  settings["extensions"] = [...paths, ...kept];
  if (settings["defaultProvider"] === undefined) settings["defaultProvider"] = PROVIDER_ID;
  writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

export function prepareLaunch(
  env: NodeJS.ProcessEnv = process.env,
  root: string = packageRoot(),
): LaunchPlan {
  const agentDir = defaultAgentDir(env);
  migrateMcpConfig(agentDir);
  const paths = extensionPaths(root);
  const settingsPath = seedAgentDir(agentDir, paths, root);
  const brandingPackageDir = seedBrandingPackage(agentDir);
  const launchEnv: NodeJS.ProcessEnv = {
    ...env,
    [PI_AGENT_DIR_ENV]: agentDir,
    [XENOPI_AGENT_DIR_ENV]: agentDir,
    [PACKAGE_DIR_ENV]: brandingPackageDir,
    PI_SKIP_VERSION_CHECK: "1",
  };
  return {
    agentDir,
    settingsPath,
    brandingPackageDir,
    extensionPaths: paths,
    cliPath: resolvePiCli(),
    env: launchEnv,
  };
}

export const PROJECT_SETTINGS_KEYS = ["extensions", "defaultProvider", "defaultModel", "packages"];

export function projectOverrideWarning(cwd: string): string | undefined {
  const path = join(cwd, ".xenopi", "settings.json");
  if (!existsSync(path)) return undefined;
  const settings = readSettings(path);
  const overrides = PROJECT_SETTINGS_KEYS.filter((key) => settings[key] !== undefined);
  if (overrides.length === 0) return undefined;
  return `xenopi WARNING: ${path} overrides ${overrides.join(", ")} for this project; project scope wins over the xenopi agent dir, so the xenolith provider may not be active`;
}

export async function launch(argv: string[] = process.argv.slice(2)): Promise<void> {
  const plan = prepareLaunch();
  const informational = argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg)) ||
    ["mcp", "config", "install", "remove", "update", "list"].includes(argv[0] ?? "");
  if (!informational) {
    const settings = readSettings(plan.settingsPath);
    if (settings["defaultProvider"] === PROVIDER_ID) {
      const projectSettings = readSettings(join(process.cwd(), ".xenopi", "settings.json"));
      const mode = (projectSettings["tuiMode"] ?? settings["tuiMode"]) === "regular" ? "regular" : "fullscreen";
      const info = await withStartupDisplay((onStatus) => describeService(resolveXenolithSettings(plan.agentDir), onStatus), argv, mode);
      settings["defaultModel"] = info.model;
      writeAtomic(plan.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }
  const warning = projectOverrideWarning(process.cwd());
  if (warning) process.stderr.write(`${warning}\n`);
  process.env[PI_AGENT_DIR_ENV] = plan.agentDir;
  process.env[XENOPI_AGENT_DIR_ENV] = plan.agentDir;
  process.env[PACKAGE_DIR_ENV] = plan.brandingPackageDir;
  process.env["PI_SKIP_VERSION_CHECK"] = "1";
  process.argv = [process.argv[0] ?? "node", plan.cliPath, ...argv];
  await import(`file://${plan.cliPath}`);
}
