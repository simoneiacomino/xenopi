import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { bindingsPath } from "../config.js";

export interface BindingRecord {
  wireSession: string;
  updated: number;
}

export class BindingStore {
  private readonly path: string;
  private records = new Map<string, BindingRecord>();

  constructor(agentDir: string) {
    this.path = bindingsPath(agentDir);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return;
      const bindings = (parsed as { bindings?: unknown }).bindings;
      if (typeof bindings !== "object" || bindings === null) return;
      for (const [piSession, value] of Object.entries(bindings as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const wireSession = (value as { wireSession?: unknown }).wireSession;
        if (typeof wireSession !== "string") continue;
        const updated = (value as { updated?: unknown }).updated;
        this.records.set(piSession, {
          wireSession,
          updated: typeof updated === "number" ? updated : 0,
        });
      }
    } catch {
      this.records = new Map();
    }
  }

  private persist(): void {
    const bindings: Record<string, BindingRecord> = {};
    for (const [piSession, record] of this.records) bindings[piSession] = record;
    const body = `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`;
    const directory = this.path.slice(0, this.path.lastIndexOf("/"));
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }

  get(piSession: string): string | undefined {
    return this.records.get(piSession)?.wireSession;
  }

  set(piSession: string, wireSession: string): void {
    this.records.set(piSession, { wireSession, updated: Date.now() });
    this.persist();
  }

  delete(piSession: string): void {
    if (!this.records.delete(piSession)) return;
    this.persist();
  }

  entries(): [string, BindingRecord][] {
    return [...this.records.entries()];
  }

  get file(): string {
    return this.path;
  }
}

export function listPiSessionIds(agentDir: string, sessionDirOverride?: string): Set<string> {
  const found = new Set<string>();
  const roots = sessionDirOverride ? [sessionDirOverride] : [join(agentDir, "sessions")];
  for (const root of roots) {
    collectSessionIds(root, found, 0);
  }
  return found;
}

function collectSessionIds(directory: string, found: Set<string>, depth: number): void {
  if (depth > 2) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSessionIds(path, found, depth + 1);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    const underscore = entry.name.lastIndexOf("_");
    if (underscore >= 0) found.add(entry.name.slice(underscore + 1, -".jsonl".length));
    const header = readSessionHeaderId(path);
    if (header) found.add(header);
  }
}

function readSessionHeaderId(path: string): string | undefined {
  try {
    const contents = readFileSync(path, "utf8");
    const newline = contents.indexOf("\n");
    const line = newline < 0 ? contents : contents.slice(0, newline);
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
