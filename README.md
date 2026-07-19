# Noice Pi

Public MIT-licensed [Pi](https://github.com/earendil-works/pi) packages from Noice Tech.

## Packages

| Package                                                  | Description                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@noice-tech/pi-changelog`](packages/changelog)         | Commit, pull request, changelog preview, and release-notes workflows for Pi. |
| [`@noice-tech/pi-terminal-bell`](packages/terminal-bell) | Terminal bell notifications when Pi is ready.                                |

Install the package you want from npm in the repository where you want to use it:

```bash
pi install npm:@noice-tech/pi-changelog
pi install npm:@noice-tech/pi-terminal-bell
```

See each package README for its commands, prerequisites, permissions, and behavior.

## Development

Use Node 24.13.0 and pnpm 11.3.0.

```bash
pnpm install
pnpm check
```

The root workspace is private and is not published. Local Pi settings load both workspace packages relative to `.pi/settings.json` for dogfooding; `.pi`, tests, and development configuration are excluded from package tarballs by strict files allowlists.

## Publishing

Maintainers should read [CONTRIBUTING.md](CONTRIBUTING.md) for release preparation and first-publication instructions. The release script creates and pushes a release commit and tag, but never publishes to npm.
