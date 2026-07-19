# Contributing

## Development

Prerequisites:

- Node 24.13.0
- pnpm 11.3.0
- Git
- `tar` on `PATH` (used by package smoke tests to inspect archives)

Install and run the repository checks:

```bash
pnpm install
pnpm format
pnpm check
```

Keep changes focused and update package documentation when behavior changes.

## Preparing a later release

From a clean, up-to-date `main` branch, run the release preparation command with the exact workspace package name and an increasing version:

```bash
pnpm release:prepare @noice-tech/pi-terminal-bell X.Y.Z
```

Substitute another publishable package name, such as `@noice-tech/pi-changelog`, when releasing that package. The script selects one publishable direct child of `packages/` by its exact package name. It requires a canonical, increasing `X.Y.Z` version, updates only that package's version, runs `pnpm check`, commits `Release <package-name> <version>`, creates the annotated tag `<package-name>@<version>`, then atomically pushes `main` and the tag to GitHub. It never runs `npm publish` or `pnpm publish`.

If validation fails before the commit or tag, the package manifest remains modified so the problem is visible. Fix the issue or restore the manifest before retrying. If the atomic push fails, the local release commit and tag remain available for inspection; verify the remote outcome and follow the recovery command printed by the script. GitHub cannot accept only one of the branch and tag updates from the atomic push.

## First npm publication

A package introduced with an already-versioned initial `1.0.0` uses the clean-main first-publication path instead of `release:prepare`. Repository-wide pnpm Git checks remain enabled. When validating an uncommitted development tree, select the exact package and bypass the checks only for that dry-run command:

```bash
PACKAGE_NAME=@noice-tech/pi-terminal-bell
pnpm --filter "$PACKAGE_NAME" publish --dry-run --no-git-checks
```

The bypass above is only for an optional dry run from an uncommitted development tree. Never use it for a real publication.

Before publishing, confirm npm organization access and validate the exact clean, up-to-date merged `main` commit. Run a frozen install, the full repository checks (including exact package archive smoke tests), and a fresh publish dry-run without bypassing Git checks:

```bash
PACKAGE_NAME=@noice-tech/pi-terminal-bell
git switch main
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile
pnpm check
pnpm --filter "$PACKAGE_NAME" publish --dry-run
```

If every command passes without changing the worktree, publish from that same commit:

```bash
pnpm --filter "$PACKAGE_NAME" publish --access public
```

Do not create a `1.0.0` tag merely to stage a package migration. For every later increasing release, prepare the release with `release:prepare`, review the pushed tag, and publish separately using the same explicit package selection.
