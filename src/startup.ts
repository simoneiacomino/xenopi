import {
  Loader, matchesKey, ProcessTerminal, Spacer, styleText, Text,
  TuiAltScreen, TuiMainScreen, type Terminal, type TuiMode,
} from "@earendil-works/pi-tui";
import type { ConnectionPhase } from "./activity.js";
import { InferenceDisplay } from "./progress.js";
import { XENOPI_VERSION } from "./product.js";

/** Pi needs model discovery before creating its chat; use its TUI during that wait. */
export async function withStartupDisplay<T>(
  body: (onStatus: (phase: ConnectionPhase) => void) => Promise<T>,
  argv: string[] = process.argv.slice(2),
  mode: TuiMode = "fullscreen",
  terminal: Terminal = new ProcessTerminal(),
): Promise<T> {
  const separator = argv.indexOf("--");
  const flags = separator >= 0 ? argv.slice(0, separator) : argv;
  const nonInteractive = flags.some((arg, index) =>
    arg === "-p" || arg === "--print" || arg.startsWith("--mode=") && arg !== "--mode=text" ||
    (arg === "--mode" && flags[index + 1] !== "text"));
  if (!process.stdin.isTTY || !process.stdout.isTTY || nonInteractive) return body(() => undefined);

  const tuiMode = flags.indexOf("--tui-mode");
  if (tuiMode >= 0 && (flags[tuiMode + 1] === "regular" || flags[tuiMode + 1] === "fullscreen")) {
    mode = flags[tuiMode + 1] as TuiMode;
  }
  const ui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const dim = (text: string) => styleText(text, { dim: true }, "256color");
  const loader = new Loader(ui, (text) => text, (text) => text, "Connecting to Xenolith…");
  ui.addChild(new Text(`${styleText("xenopi", { bold: true }, "256color")}${dim(` v${XENOPI_VERSION}`)}\n${dim("XenoPi runs local models through the Xenolith service.")}`, 1, 1));
  ui.addChild(loader);
  ui.addChild(new Spacer(1));
  ui.addChild(new Text(dim("Ctrl+C to exit"), 1, 0));
  const display = new InferenceDisplay((line) => {
    if (line !== undefined) loader.setMessage(line);
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    display.clear();
    loader.stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    // Fullscreen restores the shell without copying the startup screen.
    // Regular mode must move below its output before handing off the terminal.
    ui.stop({ preserveScreen: mode === "fullscreen" });
  };
  const quit = (code: number) => { stop(); process.exit(code); };
  const interrupt = () => quit(130);
  const terminate = () => quit(143);
  ui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) interrupt();
    return { consume: true };
  });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    ui.start();
    display.update(0, { type: "begin" });
    display.update(0, { type: "phase", phase: "connecting" });
    ui.renderNow();
    return await body((phase) => {
      if (phase !== "ready") display.update(0, { type: "phase", phase });
    });
  } finally {
    stop();
  }
}
