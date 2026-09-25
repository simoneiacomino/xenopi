import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { XENOPI_VERSION } from "../product.js";

export const XENOPI_NAME = "XenoPi";

export const XENOPI_IDENTITY =
  "You are an expert coding assistant operating inside pi, a local first coding agent harness designed for intel Xe laptops. You help users by reading files, executing commands, editing code, and writing new files.";

const PI_DEFAULT_IDENTITY =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const BRAND_MARKER =
  "You are an expert coding assistant operating inside pi, a local first coding agent harness designed for intel Xe laptops.";

export function brandSystemPrompt(systemPrompt: string): string {
  let branded = systemPrompt;
  if (systemPrompt.includes(PI_DEFAULT_IDENTITY)) {
    branded = systemPrompt.replace(PI_DEFAULT_IDENTITY, XENOPI_IDENTITY);
  } else if (!systemPrompt.includes(BRAND_MARKER)) {
    branded = `${XENOPI_IDENTITY}\n\n${systemPrompt}`;
  }
  return branded
    .replace(
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "XenoPi runtime documentation (read only when the user asks about XenoPi itself, its SDK, extensions, themes, skills, or TUI):",
    )
    .replace("When reading pi docs or examples", "When reading XenoPi runtime docs or examples")
    .replace("When working on pi topics", "When working on XenoPi or its underlying runtime")
    .replace("Always read pi .md files completely", "Always read the relevant runtime .md files completely");
}

export function installXenoPiHeader(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setHeader((_tui, theme) => ({
    render(): string[] {
      const logo = theme.bold(theme.fg("accent", "xenopi")) + theme.fg("dim", ` v${XENOPI_VERSION}`);
      const hint = (keybinding: Parameters<typeof keyText>[0], description: string): string =>
        theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
      const rawHint = (key: string, description: string): string =>
        theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
      const hints = [
        hint("app.interrupt", "interrupt"),
        rawHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
        rawHint("/", "commands"),
        rawHint("!", "bash"),
        hint("app.tools.expand", "more"),
      ].join(theme.fg("muted", " · "));
      const description = theme.fg(
        "dim",
        "XenoPi runs local models through Xenolith on Intel laptop hardware.",
      );
      return ["", logo, hints, description, ""];
    },
    invalidate(): void {},
  }));
}

export default function xenopiBranding(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    installXenoPiHeader(ctx);
  });
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
    systemPrompt: brandSystemPrompt(event.systemPrompt),
  }));
}
