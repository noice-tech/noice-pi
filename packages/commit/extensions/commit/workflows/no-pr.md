# No-PR workflow

Do not invoke `gh` or inspect/change any PR. This workflow requires no GitHub CLI.

If there is no intended dirty work, report no changes; do not perform metadata-only work. Otherwise create a fresh branch when starting on the repository default branch, `main`, or `master`, preserving other named branches. Commit using the format policy, then push, setting upstream when needed.

Report the real commit/push state and remaining worktree changes. PR must be `not inspected (--no-pr)`, not a claim that none exists.
