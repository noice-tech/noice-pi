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

## Deterministic `/commit` workflow

`/commit` waits for the active turn to finish, then the extension inspects and mutates Git and GitHub. A hidden turn branched from the active conversation decides which opaque status entries belong to the user's work and generates commit/PR wording, preserving conversation context and the provider prompt cache. The extension blocks tools during that turn and strictly validates that every dirty entry is selected or intentionally ignored. It then returns to the original conversation branch, commits only selected entries through an isolated Git index, leaves ignored worktree and staged state untouched, pushes the branch, and creates or updates the matching PR.

Every extension-owned CLI invocation is retained as a hidden session message, including its command, working directory, result, timing, and bounded output. These audit entries remain available in `/tree` while staying out of the normal transcript and model context.

An existing open PR keeps its base branch. For a new PR, base configuration is read in this order:

1. `branch.<name>.noice-base`
2. `branch.<name>.gh-merge-base`
3. unambiguous branch-ancestry inference

Set a base explicitly with, for example, `git config branch.my-branch.noice-base staging`. Ambiguous bases and closed, merged, or multiple matching PRs fail without creating a PR. Rerunning on a clean branch that is ahead of its base safely pushes missing commits and creates, updates, or leaves the single matching PR as appropriate. Existing manual PR sections are retained; `/commit` deterministically owns `Summary`, `Changelog`, and `Verification`.

`/commit stacked [changeType] [what was done]` puts the selected dirty changes in a new layer above the current branch's open PR. It uses the `gh stack` CLI as the stack authority: importing or initializing local stack tracking, adding and checking out the child branch, and submitting the already-created PR through `gh stack submit --auto`. Existing stack branches must already be published, and the current PR must be the top layer. Plain `/commit` continues to update the current branch and PR.

## Requirements and side effects

- Git and an authenticated [GitHub CLI](https://cli.github.com/) are required for `/commit`, `/unreleased`, and `/release-notes`. `/commit stacked` additionally requires the [`github/gh-stack`](https://github.com/github/gh-stack) CLI extension.
- `/commit` can fetch remote refs, create a branch, stage model-selected changes, commit, push, and create or update a PR. The model returns only strict selection/prose JSON; no shell or repository tools are exposed to it, and the extension performs every mutation.
- `/unreleased` fetches tags but changes no source or GitHub state. `/release-notes` overwrites its two output files.
