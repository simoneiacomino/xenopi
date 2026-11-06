# Engine configuration and sessions

Use a Xenolith build with native configuration support and make its executable
available on `PATH`. Initialize the configuration once; skip `config init` if
you already configured Xenolith through its installer or another client.
XenoPi uses that same configuration without a separate model or socket setting.
For an executable outside `PATH`, set `XENOLITH_BIN=/absolute/path/to/xenolith`.

XenoPi connects to or starts the Xenolith service when a session starts. The model stays on your machine.
To use an already running service, set `XENOLITH_SOCKET=/path/to/wire.sock` and `XENOLITH_NO_SPAWN=1`.

The provider discovers the model ID, context window, output limit and reasoning capabilities through `describe`.
When a saved wire conversation exceeds the service's current context capacity,
XenoPi reports its token count and the limit as the Pi session opens. The wire
open is rejected; its binding and saved history are preserved. Restart Xenolith
with a sufficient `--ctx` to reopen it. XenoPi also handles this error on the
first provider request, without silently creating a replacement conversation.
XenoPi supports wire protocol v1 for text and the opt-in v2 image capabilities of Xenolith.
The default Xenolith model is refreshed from the service at launch. A default provider chosen by the user is preserved.
`--help`, `--version`, and the `mcp` configuration commands do not require a running engine.

The normal configuration is Xenolith's native
`$XDG_CONFIG_HOME/xenolith/config.json`, or `~/.config/xenolith/config.json`.
Xenolith reads and validates it. XenoPi invokes `xenolith config inspect --json`
to discover the resolved socket and startup paths, then connects or runs
`xenolith serve` with the same configuration. Keep inference settings in that engine configuration.

For example, a native file can contain:

```json
{
  "schema_version": 1,
  "model": "/absolute/path/to/model.gguf",
  "context": 65536,
  "cache_budget": "4GiB"
}
```

An optional `XENOLITH_CONFIG=/absolute/path/to/config.json`, or `config` in
XenoPi's existing `xenolith.json`, selects another native file. The environment
selection takes precedence. Without these overrides both source builds and
installer builds use the engine's normal location. See the
[Xenolith CLI reference](https://github.com/simoneiacomino/xenolith/blob/main/docs/cli.md).

An explicitly configured socket is tried first, even if the binary or native
file is unavailable. A missing binary can also connect to an existing service
on the conventional socket. Otherwise startup requires an executable on `PATH`
or `XENOLITH_BIN`. Invalid native configuration, unsupported schemas and runtime
errors are reported instead of silently switching to another configuration.
`XENOLITH_NO_SPAWN=1` prevents automatic startup. Permission or protocol errors
do not cause a replacement engine to be started.

The running service's `describe` response always supplies the actual model,
context and capabilities. Editing the file does not reconfigure an active
engine; restart it explicitly to apply changes.

## Existing per-client overrides

These selections apply when XenoPi discovers or starts an engine. Settings in
`xenolith.json` belong to XenoPi; Xenolith itself receives CLI arguments derived
from them. Precedence runs from left to right:

| Setting | Selection order |
| --- | --- |
| Native configuration file | `XENOLITH_CONFIG` > `config` > engine default |
| Engine executable | `XENOLITH_BIN` > `bin` > `xenolith` on PATH |
| Socket | `XENOLITH_SOCKET` > `socket` > native discovery |
| Engine state directory | `XENOLITH_STATE_DIR` > `stateDir` > native setting/default |
| Engine cache directory | `XENOLITH_CACHE_DIR` > `cacheDir` > native setting/default |
| Model | `XENOLITH_MODEL` > `model` > native setting |
| Context | `XENOLITH_CONTEXT` > `context` > native setting/default |
| Projector | `XENOLITH_MMPROJ` > `mmproj` > native setting |

Existing `~/.xenopi/agent/xenolith.json` settings (under `XENOPI_DIR` when set)
and their environment overrides remain supported. Explicit `model`, `mmproj`,
`context`, `stateDir`, `cacheDir`, `cacheBudget` and `idleShutdownMinutes`
override native startup settings. `XENOLITH_CONTEXT` requests a positive integer
capacity; the engine validates its supported range. `cacheBudget` accepts an
integer byte count or a size such as `"12GiB"`; `0` disables disk cache reads
and writes without deleting existing files. Environment values retain their
precedence over this per-client file. XenoPi's `XENOLITH_STATE_DIR` still denotes
engine state, not a client binding directory.

No old file is rewritten or migrated automatically. Remove superseded explicit
overrides when choosing to use the shared configuration. With an older engine
that does not implement native configuration, an explicit legacy model still
allows startup; that path retains its previous 30-minute idle default. Native
startup leaves unspecified inference and idle settings to Xenolith.

XenoPi preferences such as its UI, tools, MCP and image budget remain in XenoPi's
own files.

## CPU settings for a new engine

XenoPi passes its environment to an engine it starts. With the binary and model
configured, use automatic CPU selection or set a worker count:

```sh
XE_WORKERS=6 xenopi
```

Use `XE_CPU_LIST` instead to select CPU IDs verified on that machine. There is
no worker-count or CPU-map field in `xenolith.json`. See the
[engine CPU options](https://github.com/simoneiacomino/xenolith/blob/main/docs/cli.md)
for validation and precedence. A running service keeps its existing CPU plan;
restart Xenolith to change it. Restarting only XenoPi does not change that plan.
