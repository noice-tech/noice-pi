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

The canonical shared classification rules live in `extensions/changelog/rules.md`.

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
