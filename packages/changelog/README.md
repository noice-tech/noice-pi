# @noice-tech/pi-changelog

Preview unreleased changes and write privacy-safe release notes in Pi.

## Install

```bash
pi install -l npm:@noice-tech/pi-changelog
```

This also installs [`@noice-tech/pi-commit`](https://github.com/noice-tech/noice-pi/tree/main/packages/commit), providing `/commit` and `/commit-config`. Commit the resulting `.pi/settings.json` change to install both for collaborators.

## Commands

| Command                                        | What it does                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `/commit [stacked] [options] [type] [summary]` | Commits and pushes changes and optionally creates or updates a pull request.  |
| `/commit-config`                               | Configures PR behavior and commit types.                                      |
| `/unreleased`                                  | Audits changes since the latest tag without changing project files or GitHub. |
| `/release-notes <version \| tag \| from..to>`  | Writes public release notes and a private source audit.                       |
| `/setup-release-notes-style [notes]`           | Configures repository-specific release-note voice and formatting.             |

See the [`@noice-tech/pi-commit` README](https://github.com/noice-tech/noice-pi/tree/main/packages/commit) for commit options, configuration, requirements, and stacked pull requests.

## Workflow

1. `/commit` adds a `Public summary` to the pull request.
2. `/unreleased` previews public and internal changes since the latest tag.
3. `/release-notes` turns a tag or range into publishable copy.

`Public summary` is the canonical changelog source. Release notes fall back to PR context, the GitHub Release body, PR title, then commit message. Internal changes and summaries marked `None.` stay out of public copy.

## Output and privacy

`/release-notes 1.2.3` creates or replaces:

- `release-notes/1.2.3.md` — public copy
- `.pi/tmp/pi-changelog/release-notes-sources/1.2.3.md` — private source audit

The public file excludes GitHub links, PR numbers, commit hashes, private URLs, and internal notes. Keep `.pi/tmp/` ignored and unpublished. Without `.pi/release-notes-style.md`, output is a plain Markdown bullet list.

## Requirements

- Authenticated [GitHub CLI](https://cli.github.com/) for `/unreleased` and `/release-notes`
- Git and any additional tools required by the selected [`@noice-tech/pi-commit`](https://github.com/noice-tech/noice-pi/tree/main/packages/commit) mode

`/unreleased` fetches tags. `/release-notes` overwrites its output files. Commit commands can create branches, commits, pushes, and pull requests.
