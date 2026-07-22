# @noice-tech/pi-work-context

See which task, worktree, PR, and CI status each Pi terminal belongs to at a glance.

```text
#6 — Plan issue · PR #42
PR ● #42 ↗   CI ✓ 8/8
```

## Install

```bash
pi install npm:@noice-tech/pi-work-context
```

Restart Pi after installation. There are no package-specific commands; the display updates automatically.

## Terminal title

| Available context   | Title                                   |
| ------------------- | --------------------------------------- |
| Session name and PR | `[state] <session name> · PR #<number>` |
| PR only             | `[state] #<number> — <PR title>`        |
| No PR               | Session name, then worktree name        |

Use Pi's `/name` command to set the session name. PR markers are: none for open, `◇` for draft, `✓` for merged, and `×` for closed.

## PR and CI status

An attached PR adds a right-aligned widget below the editor. Its number is clickable, and its dot shows whether the PR is open, draft, merged, or closed.

CI shows `✓ passed/total`, `… passed/total`, `× failed/total`, or `—` when no checks are reported.

## Requirements and fallback

- Runs only in Pi's interactive TUI
- Git provides worktree context
- Authenticated [GitHub CLI](https://cli.github.com/) adds PR and CI context

Without GitHub access or an attached PR, the title falls back to the session or worktree name. Discovery failures never interrupt Pi.

The display refreshes after `/name`, agent runs, and branch changes, and once a minute while idle.
