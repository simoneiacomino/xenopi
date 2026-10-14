# What is XenoPi

XenoPi is a small distribution of [pi](https://github.com/earendil-works/pi) that talks to Xenolith through its wire protocol.
I made it to try the protocol with a real coding agent.

The adapter translates pi's requests into Xenolith sessions. So when you continue a conversation it can append the new turn, and things like rewinds and checkpoints can use the same session too.
This is mainly a demo of the protocol. For the engine, the hardware and the model, see the [Xenolith README](https://github.com/simoneiacomino/xenolith/blob/main/README.md).

# Build and run

XenoPi 0.2 uses Pi 1.0.2. You need Node.js 26 or newer, a built Xenolith binary, and a model supported by that service.
From this directory:

```sh
npm ci --ignore-scripts
npm run build
XENOLITH_BIN=/path/to/xenolith XENOLITH_MODEL=/path/to/model.gguf node dist/src/bin/xenopi.js
```

XenoPi connects to or starts the Xenolith service when a session starts. The model stays on your machine.
To use an already running service, set `XENOLITH_SOCKET=/path/to/wire.sock` and `XENOLITH_NO_SPAWN=1`.

The provider discovers the model ID, context window, output limit and reasoning capabilities through `describe`.
When a saved wire conversation exceeds the service's current context capacity,
XenoPi reports its token count and the limit as the Pi session opens. The wire
open is rejected; its binding and saved history are preserved. Restart Xenolith
with a sufficient `--ctx` to reopen it. XenoPi also handles this error on the
first provider request, without silently creating a replacement conversation.
XenoPi supports wire protocol v1 for text and the opt-in v2 image capabilities of Xenolith. It does not contain a model catalog or model-specific schema transformations.
The default Xenolith model is refreshed from the service at launch. A default provider chosen by the user is preserved.
`--help`, `--version`, and the `mcp` configuration commands do not require a running engine.

## Images with the existing Xenolith vision implementation

XenoPi uses Xenolith's existing encoder/projector and Gemma implementation. Configure
`mmproj` once in `~/.xenopi/agent/xenolith.json`, next to `model` and `bin`:

```json
{
  "bin": "/path/to/xenolith",
  "model": "/path/to/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf",
  "mmproj": "/path/to/the/existing/mmproj-F16.gguf",
  "context": 65536
}
```

`XENOLITH_MMPROJ` overrides the projector path. XenoPi passes it as `--mmproj`
only when starting Xenolith. An already running service supplies its actual
capabilities through `describe`; no projector argument is needed for each image.
Use the same pinned model and F16 projector documented and verified in Xenolith.
This implementation currently supports vision at 65536 and 131072 context
positions; the engine validates that limit. Text-only services remain supported.

Start an interactive conversation with the kitten, or attach a local PNG/JPEG:

```sh
node dist/src/bin/xenopi.js @/path/to/gattino.jpg "Che cosa c'è in questa immagine?"
```

You can continue chatting about it. Within an existing chat, ask the agent to
use its standard `read` tool on an image, for example: `Leggi /path/to/gattino.jpg
e descrivi quello che vedi`. Image-producing tools, including screenshots and
MCP results, use Pi's ordinary typed image content. XenoPi sends encoded bytes,
so the file must exist on the client machine, not on the Xenolith server.

One image per user message or tool result is supported. Send other images in
separate turns. Text blocks in a message form its caption; images are not
silently dropped or split into invented turns. The adapter accepts PNG/JPEG
and checks MIME type, Base64, the service's byte limits and frame size. Pi may
resize images before storing them in history according to its normal settings.

The visual budget defaults to the value advertised by Xenolith (currently 280).
Set `imageBudget` in `xenolith.json`, or `XENOLITH_IMAGE_BUDGET`, to choose another
advertised budget (currently 70, 140, 280, 560 or 1120). Increasing it costs more
encoder work and context space. Changing it rebuilds affected visual prefixes.

Pi sessions retain inline bytes; Xenolith retains its own source media. Reopening,
forking and rebuilding therefore do not depend on the original file path.
Image synchronization keys bind SHA-256 of the transmitted encoded bytes and
budget. Confirmed media IDs are reused only within their owning wire conversation.
Visual compaction and branch summaries receive actual images, not placeholders;
a failed visual summary cancels that operation and preserves the conversation.

The TUI shows `Preparing image` while waiting for image append/rebuild. This is
wall time, not an encoder percentage or token rate. Xenolith's synchronous
preparation cannot be interrupted by the wire cancel operation: after a user
cancels, XenoPi waits for the in-flight preparation to settle and does not start
another generation. Once generation starts, ordinary wire cancellation applies.

See [VISION.md](VISION.md) for architecture, limits and validation.

## Engine configuration

Set `context` in `~/.xenopi/agent/xenolith.json` (under `XENOPI_DIR` when set),
or override it with `XENOLITH_CONTEXT`, to request a context capacity in tokens:

```json
{"context": 32768}
```

The value must be a positive integer. When starting Xenolith, XenoPi passes it
as `--ctx`; the engine validates the supported range for its model. Omit it to
use the engine's default. Startup errors include the engine's diagnostic.
For an already running service, `describe` supplies the actual capacity. If it
differs from the requested value, XenoPi warns and uses the service's capacity;
applying a different value requires restarting Xenolith.

Set `cacheBudget` in the same file, or override it with `XENOLITH_CACHE_BUDGET`,
to pass `--cache-budget` to a supporting Xenolith build. Use an integer byte
count or a size string such as `"12GiB"`; `0` disables disk cache reads and
writes without deleting existing files. Omit it to use the engine's default.
Changing the value for a running service requires restarting Xenolith.

# MCP and Codemode

MCP is provided by Pi's built-in extension. Use `xenopi mcp --help` for server management and `/mcp` inside a session for connections and authentication.
The user configuration is `~/.xenopi/agent/mcp.json`, or `mcp.json` under `XENOPI_DIR` when set. Trusted projects can use `.xenopi/mcp.json`.

```json
{
  "mcpServers": {
    "local": { "command": "/path/to/server", "args": [] },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${SERVICE_TOKEN}" }
    }
  }
}
```

Servers use Pi's default `codemode` exposure: the model runs JavaScript to discover and call tools without placing every MCP schema in its prompt.
Set a server's `exposure` to `direct` to declare its tools immediately, or `deferred` to load them through `tool_search`.
Tool names follow Pi's `mcp__server__tool` convention. See the [Pi MCP documentation](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/mcp.md).

Tool schemas are passed to Xenolith unchanged. Direct or deferred tools must have schemas supported by the service's renderer; the current Gemma renderer can reject complex schemas such as properties expressed only through `$ref` or `anyOf`.
Codemode keeps those MCP schemas out of the inference request, while Pi and the MCP server retain responsibility for argument validation and execution.

# Upgrading from XenoPi 0.1

The launcher removes its old MCP extension from the generated extension list. The custom `xenopi/mcp` export and MCP client helpers are removed.
The fixed model constants are also removed from the public API. Integrations can call `describeService(settings)` and pass its response to `providerModel(info)`.
Existing user-level `mcp.json` files using `servers` are converted once to `mcpServers`, with an exact backup at `mcp.json.pre-pi-1.0.2.bak`.
HTTP tokens become authorization headers; `timeoutMs` becomes Pi's per-request `timeout` in seconds (the old setting bounded connection setup).
Conflicting names, unknown legacy fields, and literal values that Pi would interpret as commands or environment substitutions require manual conversion; the original file is left untouched.
Converted servers use Codemode unless an existing native configuration explicitly says otherwise.

Saved conversations are not rewritten. Historical tool names remain in their history, while new calls use Pi's native names.
Changes to the effective system prompt or declared tools rebuild the wire context; unchanged turns continue to append only new messages.
Pi's fullscreen mode is the default. Set `"tuiMode": "regular"` in `settings.json` to use terminal scrollback.

# Validation

```sh
npm test
XENOLITH_BIN=/path/to/xenolith XENOLITH_MODEL=/path/to/model.gguf npm run test:model
```

The unit suite includes real Pi sessions, the actual CLI, local MCP servers, and a simulated wire service. Image coverage includes attachments, the read tool, compaction, branch summaries and cancellation. It covers Codemode, direct and deferred tools, reload, session synchronization and configuration migration.
To include the real vision tests, supply the existing projector and kitten:

```sh
XENOLITH_BIN=/path/to/xenolith XENOLITH_MODEL=/path/to/model.gguf \
XENOLITH_MMPROJ=/path/to/mmproj-F16.gguf XENOLITH_TEST_IMAGE=/path/to/gattino.jpg \
npm run test:model
```

For a matched text comparison, build the pre-vision baseline in another directory
and set `XENOPI_BASELINE_DIR` to it. `text-parity.test.ts` checks identical greedy
output/usage and records alternating latency samples at 64k and 128k.

The model suite starts isolated engine instances and checks inference, cache reuse, resume, rewind, compaction and native MCP/Codemode. Stop any existing engine first: the tests refuse to start a second weight owner. This machine's model battery also requires at least 21 GiB of available RAM before starting an engine.
