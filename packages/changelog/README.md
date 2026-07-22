# @noice-tech/pi-changelog

Capture release intent in each PR, preview unreleased work, and generate public notes without exposing private repository details.

## Install

```bash
pi install npm:@noice-tech/pi-changelog
```

Commit `.pi/settings.json` when collaborators should use the package too.

## Commands

| Command                                                  | What it does                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/commit [auto\|feat\|fix\|improve\|internal] [summary]` | Commits and pushes the current changes, creates or updates the PR, and records its public summary.                  |
| `/unreleased`                                            | Audits work since the latest tag as public, internal, or needing cleanup. Changes no project files or GitHub state. |
| `/release-notes <version \| tag \| from..to>`            | Writes public release notes and a separate private source audit for a tag or range.                                 |
| `/setup-release-notes-style [notes]`                     | Creates or refines `.pi/release-notes-style.md` with repository-specific voice and formatting.                      |

## From commit to changelog

```text
Code changes
  → /commit creates a typed commit and PR with a Public summary
  → merge the PR
  → /unreleased previews changes since the latest tag
  → tag and create a GitHub Release with your normal release process
  → /release-notes writes public copy and private source notes
```

The PR's `Public summary` is the canonical changelog source. Release notes fall back through `PR Context → GitHub Release body → PR title → commit message`. Internal changes and summaries marked `None` stay out of public copy.

## Change types

- `feat` — new user-facing capability
- `fix` — user-visible bug fix
- `improve` — better, faster, or more reliable user workflow
- `internal` — tooling, infrastructure, tests, refactors, or dependencies
- `auto` — let `/commit` infer one of the types above

Commits always use `type: description`. Multi-package PR titles use `type(package): description`, or `monorepo` for cross-cutting work. Scopes never appear in public copy. See the [full rules](extensions/changelog/rules.md).

## Output and privacy

`/release-notes 1.2.3` creates or overwrites:

- `release-notes/1.2.3.md` — public copy
- `.pi/tmp/pi-changelog/release-notes-sources/1.2.3.md` — private source audit

Other inputs use a filesystem-safe slug derived from the argument. The public file excludes GitHub links, PR numbers, commit hashes, private URLs, and internal notes. Keep `.pi/tmp/` ignored and unpublished. When `.pi/release-notes-style.md` is absent, the public file is a plain Markdown bullet list.

## Requirements and side effects

- Git and an authenticated [GitHub CLI](https://cli.github.com/) are required for `/commit`, `/unreleased`, and `/release-notes`.
- `/commit` uses Bash and `jq`; it can create a branch, commit, push, and create or update a PR.
- `/unreleased` fetches tags but changes no source or GitHub state. `/release-notes` overwrites its two output files.
