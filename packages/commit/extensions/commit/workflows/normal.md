# Normal PR workflow

Inspect the worktree, branch commits, repository package layout, and current branch's PR. Read an existing PR's full title/body/base before deciding whether work or metadata needs updating. If neither needs change, report no changes.

For intended dirty work, create a fresh branch when starting on the repository default branch, `main`, or `master`; otherwise preserve the branch. Commit using the format policy.

Resolve the PR title from the resulting cumulative branch diff against its base, branch commits, session context, and existing PR intent. Current-change wording must not replace a broader branch purpose. Apply the format policy's classification and scope to that full intent, correcting existing metadata when necessary; never rewrite old commits for formatting.

Push if needed, setting upstream when required. Create a missing PR with explicit `--head`, `--base`, and `--body-file`; otherwise update title/body while preserving the existing base and useful description.

## Base selection

Preserve an existing PR's `baseRefName`. For a new PR, prefer configured `branch.<branch>.gh-merge-base` or `branch.<branch>.noice-base`. Otherwise fetch remote branches and compare ancestry against likely long-lived bases (default branch, develop, staging, release/*), excluding the head branch. Prefer the most recent merge-base; if ambiguous, stop and ask for the intended base. Never rely on GitHub's implicit default. Mention a non-default inferred base in the result.
