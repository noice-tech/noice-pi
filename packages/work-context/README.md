# @noice-tech/pi-work-context

See each Pi terminal's task, worktree, local Git changes, stack layer, PR, and CI status at a glance.

```text
#6 — Plan issue · PR #42
Changes 7 · 2 untracked   Stack 2/4   PR ● #42 ↗   CI ✓ 8/8
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

## Stack layer

`Stack 2/4` means the checked-out branch is the second of four branches in a locally tracked GitHub stack. Layer `1` is closest to the trunk, and the highest number is the top of the stack. Because this comes from local `gh-stack` tracking, it can appear before the branches have been submitted as PRs. The trunk itself is not shown as a layer.

## PR and CI status

An attached PR shares the widget below the editor. Its number is clickable, and its dot shows whether the PR is open, draft, merged, or closed.

CI shows `✓ passed/total`, `… passed/total`, `× failed/total`, or `—` when no checks are reported.

### CI completion bell

Run `/work-context` and enable **CI completion bell** to receive a terminal BEL when the current PR's checks finish, whether they pass or fail. It applies immediately, is off by default, and persists across Pi restarts.

The first CI result is a quiet baseline. After that, each observed unfinished → finished transition rings once; repeated results stay quiet, and branch, repository, or PR changes reset the baseline.

Before BEL, the title briefly becomes `CI ✓ #42 — PR title` or `CI × #42 — PR title`, then returns to normal. This works only in TUI sessions with TTY output; the terminal decides whether BEL produces sound, a visual bell, or an attention request.

## Requirements and fallback

- Runs only in Pi's interactive TUI
- Git provides worktree context
- Authenticated [GitHub CLI](https://cli.github.com/) adds PR and CI context
- The optional [`github/gh-stack`](https://github.com/github/gh-stack) extension adds local stack-layer context

Without GitHub access or an attached PR, the title falls back to the session or worktree name. If `gh stack` is unavailable, the branch is not tracked, the stack is ambiguous, or discovery fails, only the stack badge is omitted. Git status, stack, and GitHub discovery fail independently and never interrupt Pi.

The title reacts immediately to `/name`. Git, stack, PR, and CI context refresh after agent runs and branch changes, and once a minute while idle. Local edits made while Pi is idle therefore appear on the next refresh; work-context does not watch the whole worktree.
