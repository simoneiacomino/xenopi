import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { withStartupDisplay } from "../../src/startup.js";

class TestTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  active = false;
  input: (data: string) => void = () => undefined;
  resize: () => void = () => undefined;
  start(input: (data: string) => void, resize: () => void): void {
    this.active = true; this.input = input; this.resize = resize;
  }
  stop(): void { this.active = false; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function terminalStreams(t: TestContext, stdin = true, stdout = true): void {
  for (const [stream, value] of [[process.stdin, stdin], [process.stdout, stdout]] as const) {
    const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(stream, "isTTY", previous);
      else Reflect.deleteProperty(stream, "isTTY");
    });
  }
}

test("startup mounts the Xenopi TUI before discovery and restores the terminal afterwards", async (t) => {
  terminalStreams(t);
  const terminal = new TestTerminal();
  const before = process.listenerCount("SIGINT");
  const result = await withStartupDisplay(async (onStatus) => {
    assert.equal(terminal.active, true);
    assert.match(terminal.output, /\x1b\[\?1049h/);
    assert.match(terminal.output, /xenopi/);
    assert.match(terminal.output, /Connecting to Xenolith/);
    onStatus("starting");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.match(terminal.output, /Starting Xenolith/);
    terminal.columns = 20;
    terminal.resize();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "ready";
  }, [], "fullscreen", terminal);
  assert.equal(result, "ready");
  assert.equal(terminal.active, false);
  assert.match(terminal.output, /\x1b\[\?1049l/);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("startup respects regular TUI mode including the CLI override", async (t) => {
  terminalStreams(t);
  for (const argv of [[], ["--tui-mode", "regular"]]) {
    const terminal = new TestTerminal();
    let handoffOffset = 0;
    await withStartupDisplay(async (onStatus) => {
      assert.match(terminal.output, /xenopi/);
      assert.doesNotMatch(terminal.output, /\x1b\[\?1049h/);
      onStatus("starting");
      await new Promise((resolve) => setTimeout(resolve, 120));
      handoffOffset = terminal.output.length;
    }, argv, argv.length ? "fullscreen" : "regular", terminal);
    assert.equal(terminal.active, false);
    assert.match(terminal.output.slice(handoffOffset), /\r\n$/,
      "the next output must start on a fresh line below the startup display");
  }
});

for (const outcome of ["error", "interrupt"] as const) {
  test(`regular startup leaves a fresh line after ${outcome}`, async (t) => {
    terminalStreams(t);
    const terminal = new TestTerminal();
    let handoffOffset = 0;
    if (outcome === "interrupt") {
      t.mock.method(process, "exit", (code: number) => {
        assert.equal(code, 130);
        assert.equal(terminal.active, false);
        assert.match(terminal.output.slice(handoffOffset), /\r\n$/);
        throw new Error("interrupted");
      });
    }
    await assert.rejects(withStartupDisplay(async (onStatus) => {
      onStatus("starting");
      await new Promise((resolve) => setTimeout(resolve, 120));
      handoffOffset = terminal.output.length;
      if (outcome === "interrupt") terminal.input("\x03");
      else throw new Error("engine failed");
    }, [], "regular", terminal), outcome === "interrupt" ? /interrupted/ : /engine failed/);
    assert.equal(terminal.active, false);
    assert.match(terminal.output.slice(handoffOffset), /\r\n$/);
  });
}

test("failed discovery restores the terminal and removes startup signal handlers", async (t) => {
  terminalStreams(t);
  const terminal = new TestTerminal();
  const before = process.listenerCount("SIGTERM");
  await assert.rejects(withStartupDisplay(async () => { throw new Error("engine failed"); }, [], "fullscreen", terminal), /engine failed/);
  assert.equal(terminal.active, false);
  assert.match(terminal.output, /\x1b\[\?1049l/);
  assert.equal(process.listenerCount("SIGTERM"), before);
});

test("Ctrl+C restores the terminal before exiting during startup", async (t) => {
  terminalStreams(t);
  const terminal = new TestTerminal();
  t.mock.method(process, "exit", (code: number) => {
    assert.equal(code, 130);
    assert.equal(terminal.active, false);
    assert.match(terminal.output, /\x1b\[\?1049l/);
    throw new Error("exit requested");
  });
  await assert.rejects(withStartupDisplay(async () => { terminal.input("\x03"); }, [], "fullscreen", terminal), /exit requested/);
});

test("noninteractive modes never mount a startup TUI even with a terminal", async (t) => {
  terminalStreams(t);
  for (const argv of [["-p"], ["--print"], ["--mode", "json"], ["--mode=json"], ["--mode", "rpc"], ["--mode=rpc"]]) {
    const terminal = new TestTerminal();
    const result = await withStartupDisplay(async (onStatus) => { onStatus("starting"); return "ready"; }, argv, "fullscreen", terminal);
    assert.equal(result, "ready");
    assert.equal(terminal.output, "");
  }
});

for (const [stdin, stdout] of [[false, true], [true, false]]) {
  test(`startup does not render with stdin TTY=${stdin} and stdout TTY=${stdout}`, async (t) => {
    terminalStreams(t, stdin, stdout);
    const terminal = new TestTerminal();
    await withStartupDisplay(async (onStatus) => { onStatus("starting"); }, [], "fullscreen", terminal);
    assert.equal(terminal.output, "");
  });
}
