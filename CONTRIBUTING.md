# Contributing

## Development

Prerequisites:

- Node 24.13.0
- pnpm 11.3.0
- Git
- GitHub CLI (`gh`) for release publication checks
- `tar` on `PATH` (used by package smoke tests to inspect archives)

Install and run the repository checks:

```bash
pnpm install
pnpm format
pnpm check
```

Keep changes focused and update package documentation when behavior changes.

## Version policy

All publishable direct children of `packages/` use one lockstep version. Every
release bumps and publishes every package, including packages whose implementation
did not change. The private root workspace is not versioned or published.

Choose the shared SemVer bump from the largest change in the release:

- breaking change in any package: major
- new backward-compatible behavior in any package: minor
- fixes or maintenance only: patch

Release notes should identify which packages changed and which were republished
unchanged.

The manifests use `1.0.1` as the aligned migration baseline, but that version was
not published as a lockstep release. The first coordinated release must therefore
be `1.0.2` or greater.

## Release flow

A release has three explicit phases. Only the final phase writes to npm.

### 1. Prepare and push the release

From a clean, up-to-date `main` branch, run:

```bash
pnpm release:prepare X.Y.Z
```

The command:

1. verifies that local `main` exactly matches `origin/main`;
2. requires `X.Y.Z` to be greater than every publishable package's current
   version;
3. writes `X.Y.Z` to every publishable `packages/*/package.json`;
4. runs `pnpm check`;
5. commits the manifests as `Release X.Y.Z`;
6. creates the annotated repository tag `vX.Y.Z`; and
7. atomically pushes `main` and the tag to GitHub.

**This command never publishes to npm.**

If validation fails before the commit or tag, the manifests remain modified so
the problem is visible. Fix the issue or restore them before retrying. If the
atomic push fails, inspect the remote outcome and follow the recovery command
printed by the script.

### 2. Create the GitHub Release

Review `vX.Y.Z`, prepare release notes, and create a published GitHub Release for
that exact tag. Do not leave it as a draft or mark a stable `X.Y.Z` release as a
prerelease.

This can be done in the GitHub UI or with GitHub CLI:

```bash
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --generate-notes
```

**Creating the GitHub Release still does not publish to npm.** It is the explicit
review gate that the local publication command verifies.

### 3. Publish every package to npm

Stay on the same clean, up-to-date `main` commit. Authenticate if necessary, then
run:

```bash
npm login
pnpm release:publish X.Y.Z
```

The command verifies all of the following before publishing:

- local `main` exactly matches `origin/main`;
- local and remote `vX.Y.Z` tags match and point to the current commit;
- every publishable package manifest is at `X.Y.Z`;
- a published, non-prerelease GitHub Release exists for `vX.Y.Z`;
- npm authentication works; and
- `pnpm check` passes without changing the worktree.

It then publishes each package sequentially as public with npm dist-tag `latest`.
This is the exact point at which npm publication happens.

`npm whoami` confirms authentication, but it cannot preflight organization
permissions or an interactive two-factor authentication challenge. Those can
still fail when publication starts.

npm does not support an atomic multi-package publish. If a later package fails,
earlier packages remain published and their exact versions cannot be reused.
Fix the problem and rerun the same command:

```bash
pnpm release:publish X.Y.Z
```

The command checks npm before each publication and skips package versions that
already exist, so retrying completes a partial release instead of attempting to
republish immutable versions.

Do not publish individual workspace packages manually during the normal release
flow. The lockstep publication command is what keeps their versions aligned.
