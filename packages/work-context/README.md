# @noice-tech/pi-work-context

See the session, local changes, stack layer, pull request, and CI status for every Pi terminal.

```text
#6 — Plan issue · PR #42
Changes 7 · 2 untracked   Stack 2/4   PR ● #42 ↗   CI ✓ 8/8
```

## Install

```bash
pi install npm:@noice-tech/pi-work-context
```

Restart Pi after installation. The display updates automatically; use `/work-context` for optional settings.

## What it shows

- **Terminal title:** session name, pull request, or worktree name. Use `/name` to name the session. Draft, merged, and closed PRs use `◇`, `✓`, and `×`.
- **Local changes:** unique changed and untracked paths, with conflicts called out first. A clean worktree stays quiet.
- **Stack layer:** `Stack 2/4` means the current branch is layer two of four in local `gh-stack` tracking.
- **Pull request:** state and a clickable PR number.
- **CI:** passed, pending, failed, or no-check status with check counts.

The widget compacts as the terminal narrows.

## CI completion bell

Run `/work-context` and enable **CI completion bell** to ring BEL when the current PR's checks finish, whether they pass or fail. It is off by default and persists across Pi restarts.

The first result establishes a quiet baseline. Each later pending-to-finished transition rings once. Changing branch, repository, or PR resets the baseline. BEL works only in TUI sessions with TTY output; your terminal controls how it is presented.

## Requirements and fallback

- Pi's interactive TUI
- Git for worktree and local-change context
- Authenticated [GitHub CLI](https://cli.github.com/) for PR and CI context
- Optional [`github/gh-stack`](https://github.com/github/gh-stack) for stack layers

Missing or failed integrations are omitted independently and never interrupt Pi. The display refreshes after agent runs and branch changes, and once a minute while idle.
