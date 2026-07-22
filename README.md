# Noice Pi

Public MIT-licensed [Pi](https://github.com/earendil-works/pi) packages from Noice Tech.

## Packages

| Package                                                  | Description                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@noice-tech/pi-changelog`](packages/changelog)         | Commit, pull request, changelog preview, and release-notes workflows for Pi. |
| [`@noice-tech/pi-terminal-bell`](packages/terminal-bell) | Terminal bell notifications when Pi is ready.                                |
| [`@noice-tech/pi-work-context`](packages/work-context)   | Session, Git worktree, pull request, and CI context in the terminal.         |

Install the package you want from npm in the repository where you want to use it:

```bash
pi install npm:@noice-tech/pi-changelog
pi install npm:@noice-tech/pi-terminal-bell
pi install npm:@noice-tech/pi-work-context
```

See each package README for its commands, prerequisites, permissions, and behavior.

## Development

Use Node 24.13.0 and pnpm 11.3.0.

```bash
pnpm install
pnpm check
```

The root workspace is private and is not published. Local Pi settings load all workspace packages relative to `.pi/settings.json` for dogfooding; `.pi`, tests, and development configuration are excluded from package tarballs by strict files allowlists.

## Publishing

All packages use one lockstep version and are published together, even when some packages have no changes. The release flow is deliberately staged:

1. `pnpm release:prepare X.Y.Z` bumps every package and pushes `vX.Y.Z`.
2. A maintainer reviews the tag and creates the GitHub Release.
3. `pnpm release:publish X.Y.Z` publishes every package from the maintainer's machine.

Only the third step writes to npm. See [CONTRIBUTING.md](CONTRIBUTING.md) for validation, credentials, and partial-publication recovery details.
