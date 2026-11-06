# Contributing to XenoPi

Target `main` with focused pull requests from short-lived branches. Explain the
problem, resulting behavior, checks performed and compatibility implications.
Discuss substantial design changes before implementation. Link dependent engine
or CodeXe PRs and state their integration order.

Use Conventional Commits for new commits and PR titles, with optional scope and
an English imperative description, for example:

```text
fix(discovery): Preserve the explicit engine endpoint
```

Use `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci` or `chore`.
Explain nontrivial motivation in the body. Mark incompatible changes with `!`
and document migration. Preserve original authors and attribution trailers;
imported history and generated merge/revert messages retain their messages.

Require relevant checks before ordinary merges. Request additional review when useful.
Keep `main` buildable. A merge does not publish a package. Release versions are
independent of Xenolith, CodeXe and the wire protocol. During `0.x`, use patch
versions for compatible fixes and minor versions for features or deliberate
breaking changes, with explicit migration notes. Select and qualify exact
artifacts before a separate publication decision.

See [Linux packages and releases](docs/releases.md) for XenoPi publication and
the [distribution guide](https://github.com/simoneiacomino/xenolith/blob/main/installer/RELEASING.md)
for selecting compatible component packages in the Xenolith installer.

Public documentation covers usage, architecture, compatibility and contribution
instructions. Keep internal execution reports, raw validation output, operational
notes and private paths outside this repository and its distributable packages.

Run `npm test` for unit coverage and `npm run test:install` for package changes.
The installation smoke supports `XENOPI_NPM_OFFLINE=1`. Standalone Linux package
changes also require the [archive smoke and promotion checks](docs/releases.md). Model tests are separate,
require a supported engine/device and sufficient memory, and must not start a
second weight owner. See [the README](README.md) for setup and test boundaries.
