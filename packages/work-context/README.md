# @noice-tech/pi-work-context

See each Pi terminal's task, worktree, local Git changes, PR, and CI status at a glance.

```text
#6 — Plan issue · PR #42
Changes 7 · 2 untracked   PR ● #42 ↗   CI ✓ 8/8
```

## Install

```bash
pi install npm:@noice-tech/pi-work-context
```

Restart Pi after installation. The display updates automatically; use `/work-context` for its optional settings.

## Terminal title

| Available context   | Title                                   |
| ------------------- | --------------------------------------- |
| Session name and PR | `[state] <session name> · PR #<number>` |
| PR only             | `[state] #<number> — <PR title>`        |
| No PR               | Session name, then worktree name        |

Use Pi's `/name` command to set the session name. PR markers are: none for open, `◇` for draft, `✓` for merged, and `×` for closed.

## Local changes

The right-aligned widget summarizes the current index and working tree. `Changes 7 · 2 untracked` means seven unique changed paths in total, two of which are untracked. Renames and copies count as one changed path, ignored files are excluded, and conflicts are shown first with warning emphasis (for example, `1 conflict · Changes 3`). Wording and detail compact at narrow terminal widths.

A clean worktree does not show a changes label, keeping the widget quiet. Work-context runs read-only porcelain Git status with optional index locking disabled and parses only its status records.

## PR and CI status

An attached PR shares the widget below the editor. Its number is clickable, and its dot shows whether the PR is open, draft, merged, or closed.

CI shows `✓ passed/total`, `… passed/total`, `× failed/total`, or `—` when no checks are reported.

### CI pass bell

Run `/work-context` and set **CI pass bell** to `on` to receive a terminal BEL when the current PR's checks move from not passed to fully passed. The setting is off by default, takes effect immediately, and persists globally across Pi restarts.

The initial CI result establishes a baseline, so opening Pi on an already-passing PR stays quiet. Repeated refreshes also stay quiet; if CI later regresses and recovers, it rings again. No checks is not a passing result.

BEL output is available only in interactive TUI sessions with TTY output. Your terminal decides whether it produces sound, a visual indicator, or an attention request. Test your terminal with `printf '\a'`.

## Requirements and fallback

- Runs only in Pi's interactive TUI
- Git provides worktree context
- Authenticated [GitHub CLI](https://cli.github.com/) adds PR and CI context

Without GitHub access or an attached PR, the title falls back to the session or worktree name. Git status and GitHub discovery fail independently and never interrupt Pi.

The title reacts immediately to `/name`. Git, PR, and CI context refresh after agent runs and branch changes, and once a minute while idle. Local edits made while Pi is idle therefore appear on the next refresh; work-context does not watch the whole worktree.
