# Build and install XenoPi

XenoPi uses Pi 1.0.2. You need Node.js 26 or newer, a built Xenolith binary, and a model supported by that service.
From the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm_config_prefix="$HOME/.local" npm link --ignore-scripts
xenolith config init --model /absolute/path/to/model.gguf
xenopi
```

`npm link` creates the `xenopi` command in `~/.local/bin`, linked to this
checkout. Keep the checkout and its `node_modules`; after source changes, run
`npm run build` again. The prefix is scoped to that command and does not change
your npm configuration. Use `npm_config_prefix` here: `npm link --prefix DIR`
instead treats `DIR` as the source project.

For an installation independent of the checkout, create a local npm archive:

```sh
npm pack
npm install --global --prefix "$HOME/.local" --ignore-scripts ./xenopi-0.1.0-rc.1.tgz
xenopi --help
```

`npm pack` runs the build and prints the archive filename; use that filename if
the version differs. The archive bundles the production dependency tree installed
by `npm ci` from `package-lock.json`, including Pi's runtime assets and licenses.
This keeps a later installation independent of changing registry versions; an
archive can be installed with `--offline`. It is larger and specific to the build
machine's OS and architecture when dependencies contain native binaries. Build
it on the target platform from a clean `npm ci` tree. Node 26+ and npm are still
required: Node, Xenolith and model weights are not bundled. You can remove the
checkout after this installation. Publishing XenoPi on npm is unnecessary for
either method. The prepared shell-installer package
also supplies Node; both methods use the same `xenopi` command and engine config.

For a standalone Linux x86_64 archive with its own Node runtime, see
[Linux packages and releases](releases.md). This repository builds that
archive; Xenolith's distribution installer selects an already built package.

With a prepared Linux distribution, Node is supplied by the installer:

```sh
sh /absolute/distribution/install.sh --source /absolute/distribution --interface xenopi
xenopi
```

The bundled Node runtime belongs to that installation; it does not replace your
system Node. The npm paths above use Node 26+ from your own `PATH`.

See [engine configuration](configuration.md) to configure Xenolith and start a session.
