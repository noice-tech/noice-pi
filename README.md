# Noice Pi

MIT-licensed workflow packages for the [Pi coding agent](https://github.com/earendil-works/pi).

## Packages

| Package                                                  | Description                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`@noice-tech/pi-commit`](packages/commit)               | Commit, push, and open pull requests without interrupting your Pi session. |
| [`@noice-tech/pi-changelog`](packages/changelog)         | Preview unreleased changes and write privacy-safe release notes.           |
| [`@noice-tech/pi-cutover`](packages/cutover)             | Turn a Pi planning session into a clean implementation handoff.            |
| [`@noice-tech/pi-github-issues`](packages/github-issues) | Pick a GitHub issue and start a focused Pi planning session.               |
| [`@noice-tech/pi-terminal-bell`](packages/terminal-bell) | Ring your terminal when Pi finishes a long run.                            |
| [`@noice-tech/pi-work-context`](packages/work-context)   | Show session, Git, pull request, and CI context in every Pi terminal.      |

Install the package you want from npm in the repository where you want to use it:

```bash
pi install -l npm:@noice-tech/pi-commit
pi install -l npm:@noice-tech/pi-changelog
pi install -l npm:@noice-tech/pi-cutover
pi install -l npm:@noice-tech/pi-github-issues
pi install -l npm:@noice-tech/pi-terminal-bell
pi install -l npm:@noice-tech/pi-work-context
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
