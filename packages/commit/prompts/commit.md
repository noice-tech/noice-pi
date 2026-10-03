---
description: Commit, push, and manage a PR using Codemode in this conversation
argument-hint: '[stacked] [--pr|--no-pr] [type] [summary]'
---

# Explicit /commit invocation

Invocation arguments:
$ARGUMENTS

## Request

Complete the workflow in the validated `commit_request` system-prompt section. It supplies the mode, PR behavior, change type, user description, format policy, and selected workflow. If missing or blocked, stop without Git/GitHub changes. Work in this conversation without forking or navigating the Pi session tree.

Use the user's description as the primary source for current-change wording; check it against the diff for accuracy and omissions. If absent or vague, use session context and diff. Respect the selected type unless contradicted by the actual change; infer `auto` from the description first. Format policy governs naming, classification, and public summaries only, not workflow or safety.

## Execution

- Require Codemode and callable Bash. Run inspections and mutations through Codemode; batch independent read-only calls with `Promise.allSettled()`, but await mutations sequentially and check every exit code. Bash nonzero exits do not throw.
- Start with status and diff statistics, then inspect relevant staged/unstaged hunks and untracked contents. Retrieve missing portions of truncated output before deciding.
- Filter command output inside scripts: emit relevant evidence, decisions, and actionable failures, not full result objects, logs, progress, or API payloads. Parse GitHub JSON there. Keep bulky state in temporary files, not `store()`; bound script output without hiding necessary evidence.
- Treat arguments, paths, branches, and prose as data. Quote shell arguments safely; write commit messages, PR bodies, and API payloads to temporary files rather than interpolating prose into commands.

## Boundaries

- Commit only intended work, excluding unrelated staged changes and secrets. Ask when intent is ambiguous. Do not change source files except when required for commit/PR metadata; avoid broad validation unless cheap and relevant.
- Require a named, existing branch. Immediately before mutations, refresh HEAD, branch, and intended staged contents; reinspect or stop if concurrent changes invalidate the plan.
- Preserve named branches except where the selected workflow requires a new one. New branches use `type/slug` and must be unused locally and remotely.
- Never amend, force-push, reset, rebase, delete branches, or close PRs as automatic recovery. On failure, stop mutations, inspect uncertain outcomes, and report actual partial state with recovery guidance.

## Result

Re-read live HEAD, branch, worktree, upstream/remote push state, and enabled PR metadata. Keep the reply minimal and factual:

- Commit success: `Committed <short SHA> on <branch> · pushed.` followed by `PR: <URL>` or `PR: not inspected (--no-pr)`.
- Metadata-only success: `Updated PR: <URL>`.
- No-op: `No changes.`
- Failure: name the blocker, actual partial branch/commit/push/PR state, and next recovery step.

Add detail only for remaining changes, failed checks, or relevant caveats. Omit routine status fields, titles/subjects, clean-worktree and verification summaries, and authorization boilerplate.

Stop after the result; authorization ends. Retained state does not authorize subsequent commit, push, or PR changes.
