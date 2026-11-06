# Linux packages and releases

XenoPi owns its Linux x86_64 archive independently of Xenolith and CodeXe.
The flat archive contains `bin/xenopi`, the complete Node distribution under
`node/`, and the npm production bundle under `lib/xenopi/`. It includes Node,
XenoPi and dependency licenses and Pi's runtime assets. Node and npm on the user's
PATH are unnecessary. Xenolith and model weights remain separate.

The bundled Node runtime requires `libatomic.so.1`: install `libatomic1` on
Ubuntu 24.04 or `libatomic` on Arch before using an extracted archive directly.
The guided Xenolith installer checks this dependency when XenoPi is selected
and offers to install it with your consent.

Use Linux x86_64, Python 3.12+ and a complete official Node 26+ Linux x64 bundle
with its `LICENSE`. Download an exact Node version from nodejs.org and verify
its archive against that version's `SHASUMS256.txt` before extraction. The manual
workflow pins Node 26.10.0. From this checkout, after selecting the source revision:

```sh
export NODE_BUNDLE=/absolute/path/node-v26.10.0-linux-x64
export PATH="$NODE_BUNDLE/bin:$PATH"
npm ci --ignore-scripts --no-audit --no-fund
python3 scripts/build_linux_package.py \
  --node-dir "$NODE_BUNDLE" --output /absolute/output/xenopi-candidate
python3 scripts/smoke_linux_package.py \
  /absolute/output/xenopi-candidate/xenopi-0.1.0-rc.1-linux-x86_64.tar.gz
python3 -m unittest discover -s .github/scripts -p 'test_verify_xenopi_candidate.py'
```

Use the current `package.json` version in the archive filename. Output must be
empty and outside the checkout. The builder checks installed production versions
against `package-lock.json`, runs the ordinary offline `npm pack` prepack build,
and takes only npm's production dependency bundle. It does not modify the source
version or installed dependencies. Its archive metadata uses the source commit
time (or an explicit `SOURCE_DATE_EPOCH`) and stable order/ownership. Reproduction
requires the same locked platform dependencies and full Node input; dependency
native binaries make this a Linux x86_64 package.

`SHA256SUMS` identifies the archive. `xenopi-release-provenance.json` records the
source SHA, dirty status, lockfile hash, builder hash, Node version/binary/license
hashes and archive digest. A dirty local build is development evidence; release
candidates come from a committed source revision in Actions. The smoke extracts
the archive into an isolated home, blocks system Node/npm fallbacks, and runs
help/version plus Pi asset checks without invoking an engine or installing
anything. This check does not qualify model inference.

To use an archive directly, verify its checksum, extract it into a permanent
installation directory and add that directory's `bin` to PATH, or symlink
`bin/xenopi` into your command directory. Keep the full extracted tree. The
existing `npm pack` and offline npm installation remain supported and require
your own Node 26+ runtime.

The manual **XenoPi release** workflow has two phases. Run it with `publish=false`
and `package_version` equal to tracked metadata. It builds and smokes the archive
without GPU access, uploading the archive, checksums and source provenance as
`xenopi-release-x86_64-unknown-linux-gnu`. Review that exact candidate and complete
any required engine/model qualification before publication.

To publish, dispatch at the same source SHA on `main` or a `release/*` branch,
with `publish=true`, the original successful `candidate_run_id`, the same version
and the explicitly approved archive SHA-256. The `release` environment should
restrict branches and require maintainer approval. The publisher verifies the
candidate repository, manual workflow, successful run, source SHA, version,
checksums and approved digest; it downloads the candidate without rebuilding.
It refuses an existing `v<VERSION>` tag, creates a draft at the selected source
SHA, attaches all three files, then publishes. A failed upload leaves an
unpublished draft; retries never replace an existing tag/release or assets.
Prereleases are marked and no release is automatically made latest. No push or
tag event publishes a release. Expired candidates must be rebuilt and qualified
again. Workflow files do not configure repository/environment protections.

The published archive URL is exact, for example:
`https://github.com/simoneiacomino/xenopi/releases/download/v0.1.0-rc.1/xenopi-0.1.0-rc.1-linux-x86_64.tar.gz`.
A distribution selects that URL, version and checksum rather than rebuilding
XenoPi. Candidate creation and publication remain separate maintainer decisions.
