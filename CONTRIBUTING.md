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

## Preparing a release

From a clean, up-to-date `main` branch, run:

```bash
pnpm release:prepare @noice-tech/pi-changelog X.Y.Z
```

The script selects one publishable direct child of `packages/` by its exact package name. It requires a canonical, increasing `X.Y.Z` version, updates only that package's version, runs `pnpm check`, commits `Release <package-name> <version>`, creates the annotated tag `<package-name>@<version>`, then atomically pushes `main` and the tag to GitHub. It never runs `npm publish` or `pnpm publish`.

If validation fails before the commit or tag, the package manifest remains modified so the problem is visible. Fix the issue or restore the manifest before retrying. If the atomic push fails, the local release commit and tag remain available for inspection; verify the remote outcome and follow the recovery command printed by the script. GitHub cannot accept only one of the branch and tag updates from the atomic push.

## First npm publication

The initial `1.0.0` publication is a separate maintainer action. Repository-wide pnpm Git checks remain enabled. When validating an uncommitted development tree, bypass them only for that dry-run command:

```bash
pnpm --filter @noice-tech/pi-changelog publish --dry-run --no-git-checks
```

Never use that bypass for a real publication. After reviewing the package dry run, confirming npm organization access, and checking out the clean release commit or tag, publish explicitly:

```bash
pnpm --filter @noice-tech/pi-changelog publish --access public
```

Do not create a `1.0.0` tag merely to stage the migration. For later releases, prepare the release with the script, review the pushed tag, and publish separately using the same explicit command.
