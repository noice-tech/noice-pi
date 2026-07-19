# @noice-tech/pi-changelog

A Pi package for release-aware commits, pull requests, unreleased previews, and public release notes.

## Install

```bash
pi install npm:@noice-tech/pi-changelog
```

Commit the resulting `.pi/settings.json` change so Pi installs the package for collaborators.

## Prerequisites and trust

The workflows expect:

- Git
- [GitHub CLI](https://cli.github.com/) authenticated for the repository
- Bash and `jq`
- a shell that supports process substitution for the documented `gh api` PR-update flow

Pi packages run with the permissions granted to Pi. **Only use this package when you trust it with full system permissions and repository access.** In particular, `/commit` inspects changes, creates commits, pushes branches, and creates or updates GitHub pull requests.

## Commands

```text
/commit [auto|feat|fix|improve|internal] [optional context]
/unreleased
/release-notes <version | from..to>
/setup-release-notes-style [product/audience/channel notes]
```

`auto` is accepted only as `/commit` inference input. Changelog and PR classifications are `feat`, `fix`, `improve`, or `internal`.

`/commit` runs its worker on a side branch of the current session at low thinking, then restores your previous thinking level when it finishes. If you invoke it during an active agent turn, the change-type selector opens immediately; after your selection, the command waits for that turn to settle before starting the worker.

### PR title package scopes

Commit messages always keep the unscoped form:

```text
internal: update PR title generation
```

PR titles stay unscoped in single-package repositories and workspaces. In a multi-package workspace, the title identifies one primary package by its workspace directory basename:

```text
internal(changelog): update PR title generation
```

The worker determines the primary package from the PR's intent and full branch against its base. Incidental shared files such as a lockfile do not override a clear primary package. Root-only, cross-cutting, or ambiguous multi-package changes use `monorepo`:

```text
internal(monorepo): centralize release tooling
```

Both scoped and unscoped PR titles are valid changelog inputs. Package scopes are metadata and are not included in public changelog copy.

The canonical shared classification and package-scope rules live in `extensions/changelog/rules.md`.

## Repository-specific release-note style

Run `/setup-release-notes-style` to create or refine the only canonical repository-specific convention:

```text
.pi/release-notes-style.md
```

`/release-notes` reads that file when present. It otherwise emits a plain Markdown bullet list.

## Release-note output

`/release-notes 1.2.3` uses a deterministic slug and writes two separate files:

- public copy: `release-notes/1.2.3.md`
- private review sources: `.pi/tmp/pi-changelog/release-notes-sources/1.2.3.md`

The public artifact never contains PR numbers, commit hashes, private URLs, or internal source notes. The `.pi/tmp/` source file is an ephemeral private-review aid. Keep `.pi/tmp/` ignored by Git and unpublished; the prompt does not edit a consumer repository's `.gitignore`.

## Package contents

The npm package distributes the Pi manifest together with raw TypeScript and Markdown extension/prompt assets. No build step is required.
