# @noice-tech/pi-changelog

Capture release intent in each PR, preview unreleased work, and generate public notes without exposing private repository details. The package composes the standalone [`pi-commit`](https://github.com/noice-tech/noice-pi/tree/main/packages/commit) workflow with changelog auditing and release-note prompts.

## Install

```bash
pi install npm:@noice-tech/pi-changelog
```

`pi-commit` is bundled, so this one install still provides `/commit` and `/commit-config`. If both packages are installed directly, their shared registration remains a single unsuffixed command. Commit `.pi/settings.json` when collaborators should use the package too.

## Commands

| Command                                       | What it does                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/commit [--pr\|--no-pr] [type] [summary]`    | Provided by `pi-commit`; commits and pushes changes and optionally creates or updates the PR.                       |
| `/commit stacked [--pr] [type] [summary]`     | Provided by `pi-commit`; creates a child branch and PR directly above the current branch's open PR.                 |
| `/commit-config`                              | Configures persistent PR behavior and semantic commit types/format for the user or trusted project.                 |
| `/unreleased`                                 | Audits work since the latest tag as public, internal, or needing cleanup. Changes no project files or GitHub state. |
| `/release-notes <version \| tag \| from..to>` | Writes public release notes and a separate private source audit for a tag or range.                                 |
| `/setup-release-notes-style [notes]`          | Creates or refines `.pi/release-notes-style.md` with repository-specific voice and formatting.                      |

See [`pi-commit`](https://github.com/noice-tech/noice-pi/tree/main/packages/commit) for complete commit configuration, no-PR behavior, stacked safety rules, and prerequisites.

## From commit to changelog

```text
Code changes
  → /commit creates a typed commit and PR with a Public summary
  → merge the PR
  → /unreleased previews changes since the latest tag
  → tag and create a GitHub Release with your normal release process
  → /release-notes writes public copy and private source notes
```

The PR's `## Changelog` → `Public summary` is the canonical changelog source. Release notes fall back through `PR Context → GitHub Release body → PR title → commit message`. Internal changes and summaries marked `None` stay out of public copy. This PR body contract remains stable even when `pi-commit` uses a custom title/message format.

The bundled opinionated format provides:

- `feat` — new user-facing capability
- `fix` — user-visible bug fix
- `improve` — better, faster, or more reliable user workflow
- `internal` — tooling, infrastructure, tests, refactors, or dependencies
- `auto` — infer one of the configured types

By default, commits use `type: description`. Multi-package PR titles use `type(package): description`, or `monorepo` for cross-cutting work. Scopes never appear in public copy.

## Output and privacy

`/release-notes 1.2.3` creates or overwrites:

- `release-notes/1.2.3.md` — public copy
- `.pi/tmp/pi-changelog/release-notes-sources/1.2.3.md` — private source audit

Other inputs use a filesystem-safe slug derived from the argument. The public file excludes GitHub links, PR numbers, commit hashes, private URLs, and internal notes. Keep `.pi/tmp/` ignored and unpublished. When `.pi/release-notes-style.md` is absent, the public file is a plain Markdown bullet list.

## Requirements and side effects

- GitHub CLI is required for `/unreleased` and `/release-notes` source inspection.
- `pi-commit` always requires Git. Its no-PR mode does not require GitHub CLI; normal PR mode does, and stacked mode additionally requires [`github/gh-stack`](https://github.com/github/gh-stack).
- `/unreleased` fetches tags but changes no source or GitHub state.
- `/release-notes` overwrites its public and private-audit output files.
- Commit operations can create branches, commits, pushes, and—when enabled—pull requests. See the `pi-commit` README before use.
