# pi-commit

An opinionated commit-to-PR workflow for Pi, with changelog-ready metadata and stacked pull requests. Unlike commit-message-only helpers, `pi-commit` can carry the change through commit, push, and pull request while preserving an explicit release intent.

## Install

```bash
pi install npm:pi-commit
```

Commit `.pi/settings.json` when collaborators should use the package too.

## Commands

```text
/commit [stacked] [--pr|--no-pr] [auto|type] [summary]
/commit-config
```

Examples:

```text
/commit fix prevent hidden tracks from rendering
/commit --no-pr internal refresh test fixtures
/commit --pr improve make long projects open faster
/commit stacked feat add export presets
```

`/commit` uses the user's summary as the primary wording source and verifies it against the session and diff. If the type is omitted, Pi presents a selector. `auto` lets the worker infer it.

- Default or `--pr`: commit, push, and create or update the pull request.
- `--no-pr`: commit and push without invoking `gh` or reading or modifying any pull request.
- `stacked`: put the dirty work in a new child branch and PR above the current branch's open PR. Stacked mode requires PRs; use `--pr` when configuration disables them.

A later `/commit --pr` can create or refresh PR metadata after a no-PR commit.

## Opinionated default

Without configuration, release intent uses:

- `feat` — new user-facing capability
- `fix` — user-visible bug fix
- `improve` — better, faster, or more reliable user workflow
- `internal` — tooling, infrastructure, tests, refactors, or dependencies

Commits use unscoped `type: description`. Single-package PR titles use the same shape. Multi-package PR titles use `type(package): description`, or `type(monorepo): description` for cross-cutting work.

Every PR keeps these stable sections:

```md
## Summary

- ...

## Changelog

Public summary:

- ...

Context:

- ...

## Verification

- ...
```

`Public summary` is intended to be a standalone future changelog source. Internal types use `None.`.

## Configure once

Run `/commit-config` to edit either the user configuration or the trusted project's configuration. The files are:

- user: `~/.pi/agent/pi-commit.json` (or the configured Pi agent directory)
- project: `.pi/pi-commit.json` (or the distribution's configured project directory)

Precedence is:

```text
built-in defaults < user config < trusted project config < command flags
```

The basic configuration is:

```json
{
  "pullRequest": "auto",
  "format": "opinionated"
}
```

Set `pullRequest` to `never` to make no-PR operation persistent. `/commit --pr` and `/commit --no-pr` override it once.

A custom semantic format defines selectable types and naming instructions:

```json
{
  "pullRequest": "never",
  "format": {
    "changeTypes": [
      {
        "name": "feat",
        "description": "A new user-facing capability",
        "public": true
      },
      {
        "name": "chore",
        "description": "Repository maintenance",
        "public": false
      }
    ],
    "instructions": "Use type(scope): description for commit messages and pull request titles. Use concise imperative descriptions."
  }
}
```

Names must start with a lowercase letter and contain only lowercase letters, digits, and hyphens. `auto` and `stacked` are reserved. A public type requires a standalone public summary; a non-public type writes `None.`. Custom instructions control only semantic naming and classification—they cannot replace Git, PR, stack, or output safety rules. Invalid configuration stops before the worker or any mutation starts.

Project configuration is ignored until the project is trusted. In non-interactive modes, `/commit-config` prints the paths and schema instead of opening an editor.

## Stacked pull requests

`/commit stacked` requires the checked-out branch to be the published active top of a valid stack with an exact same-owner open PR. It uses the public [`github/gh-stack`](https://github.com/github/gh-stack) commands to discover/import stack state, add the child, create its PR with the parent as explicit base, submit, and verify GitHub's final order.

The child commit and prose describe only the new layer. Existing layers and the parent PR remain unchanged. A failure after stack mutation can leave a local child branch, commit, pushed branch, or PR; the worker reports the state and never deletes or reuses it automatically.

## Requirements and side effects

- Git is always required.
- Normal PR mode requires authenticated [GitHub CLI](https://cli.github.com/) and `jq`.
- Stacked mode additionally requires the [`github/gh-stack`](https://github.com/github/gh-stack) extension.
- No-PR mode requires neither `gh` nor `jq`, but it intentionally pushes.
- The command can create a branch, commit, and push. PR mode can create or update a PR. Stacked mode can run `gh stack checkout`, `init`, `add`, and `submit`.
- The worker sends relevant session context and repository/diff information to the session's selected model. Review your model/provider privacy settings before using it with sensitive code.
