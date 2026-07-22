# @noice-tech/pi-work-context

A [Pi](https://github.com/earendil-works/pi) extension that keeps the terminal title and a compact editor widget aligned with the work being delivered.

## Install

```sh
pi install npm:@noice-tech/pi-work-context
```

Restart Pi after installation.

## Terminal title

The title favors richer context without losing a stable workspace fallback:

1. the explicit Pi session name (`/name`);
2. the attached GitHub pull request number and state;
3. the pull request title when the session has no explicit name; and
4. the Git worktree directory name.

Examples:

```text
#6 — Add searchable GitHub issue planning
#6 — Add searchable GitHub issue planning · PR #42
✓ #6 — Add searchable GitHub issue planning · PR #42
#42 — Add searchable GitHub issue planning
work-context
```

Open pull requests use no extra title marker. Draft, merged, and closed pull requests use `◇`, `✓`, and `×` respectively. Nested worktree layouts such as `<repo>/<worktree>/<repo>` use the middle directory as the workspace name.

The extension reacts immediately to `/name`, refreshes after agent runs and Git `HEAD` changes, and polls once a minute so externally changed pull request or CI state eventually appears while Pi is idle. Git and GitHub discovery always run in the background.

## Pull request and CI widget

An attached pull request adds a compact, right-aligned widget below the editor:

```text
PR ● #42 ↗   CI ✓ 8/8
```

The pull request number is an OSC 8 terminal hyperlink. The dot is green for open, yellow for draft, accent-colored for merged, and red for closed. CI uses:

- `✓ passed/total` when all checks pass;
- `… passed/total` while checks are pending;
- `× failed/total` when any check fails; or
- `—` when the pull request has no reported checks.

## Requirements and fallback behavior

- Git is required for worktree context.
- An authenticated [GitHub CLI](https://cli.github.com/) is optional for pull request and CI context.

Without `gh`, without authentication, outside a GitHub repository, or when the current branch has no pull request, the extension quietly keeps the session-name or worktree fallback. Malformed command output is ignored and never interrupts Pi.

## License

[MIT](./LICENSE)
