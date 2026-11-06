# Development and compatibility

## Upgrading from XenoPi 0.1

The launcher removes its old MCP extension from the generated extension list. The custom `xenopi/mcp` export and MCP client helpers are removed.
The fixed model constants are also removed from the public API. Integrations can call `describeService(settings)` and pass its response to `providerModel(info)`.
Existing user-level `mcp.json` files using `servers` are converted once to `mcpServers`, with an exact backup at `mcp.json.pre-pi-1.0.2.bak`.
HTTP tokens become authorization headers; `timeoutMs` becomes Pi's per-request `timeout` in seconds (the old setting bounded connection setup).
Conflicting names, unknown legacy fields, and literal values that Pi would interpret as commands or environment substitutions require manual conversion; the original file is left untouched.
Converted servers use Codemode unless an existing native configuration explicitly says otherwise.

Saved conversations are not rewritten. Historical tool names remain in their history, while new calls use Pi's native names.
Changes to the effective system prompt or declared tools rebuild the wire context; unchanged turns continue to append only new messages.
Pi's fullscreen mode is the default. Set `"tuiMode": "regular"` in `settings.json` to use terminal scrollback.

## Package identity

Installation tools identify native configuration support through
`"xenolith": { "nativeConfig": 1 }` in `package.json`, together with `name`,
`bin` and `piConfig`. Check the compiled entrypoint and native integration files,
then run bounded `--version` and `--help` checks. These checks work for source,
npm and bundled-Node layouts; they do not validate model inference.

## Validation

```sh
npm test
npm run test:install
XENOLITH_BIN=/path/to/xenolith XENOLITH_MODEL=/path/to/model.gguf npm run test:model
```

`npm run test:install` verifies actual `npm link`, `npm pack`, and global
installation of the local archive using isolated homes and npm prefixes with
spaces. It checks ordinary `xenopi` commands, packaged assets, branding and
help/version without invoking an engine. It checks that bundled Pi versions
match the source lockfile and development tooling is excluded. It rebuilds the
checkout and retains logs in the printed temporary directory. npm uses its own
cache; `XENOPI_NPM_OFFLINE=1 npm run test:install` also proves that the bundled
archive installs without registry access. No real global npm prefix, model, or
GPU is used.

The unit suite includes real Pi sessions, the actual CLI, local MCP servers, and a simulated wire service. Image coverage includes attachments, the read tool, compaction, branch summaries and cancellation. It covers Codemode, direct and deferred tools, reload, session synchronization and configuration migration.
To include the real vision tests, supply the matching projector and a test image:

```sh
XENOLITH_BIN=/path/to/xenolith XENOLITH_MODEL=/path/to/model.gguf \
XENOLITH_MMPROJ=/path/to/mmproj-F16.gguf XENOLITH_TEST_IMAGE=/path/to/image.jpg \
npm run test:model
```

For a matched text comparison, build the pre-vision baseline in another directory
and set `XENOPI_BASELINE_DIR` to it. `text-parity.test.ts` checks identical greedy
output/usage and records alternating latency samples at 64k and 128k.

The model suite starts isolated engine instances and checks inference, cache reuse, resume, rewind, compaction and native MCP/Codemode. Stop any existing engine first: the tests refuse to start a second weight owner. The model-test harness requires at least 21 GiB of available RAM before starting an engine.
