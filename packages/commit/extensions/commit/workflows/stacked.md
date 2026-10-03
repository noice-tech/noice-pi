# Stacked workflow

Create a new child branch/PR directly above the current branch's open PR. All child prose and package scope describe only intended dirty child work, excluding published parents. Parents are read-only. `github/gh-stack` is the stack authority; never access `.git/gh-stack` directly.

## Preflight

Complete before `gh stack add`:

1. Resolve OWNER/REPO with `gh repo view --json nameWithOwner`. Look up the parent's PR with `gh pr list --repo <repo> --head <branch> --state all --limit 100 --json number,title,body,baseRefName,headRefName,headRepositoryOwner,state,url`. Filter by repository owner case-insensitively; require exactly one match, open with the exact head branch. Same-named fork PRs do not count. Never create a replacement parent.
2. Refresh origin refs; require local HEAD equal `origin/<parent>`. If unpublished, stop with guidance to publish the parent first. Require intended dirty child work; otherwise report no changes without stack mutation.
3. Parse `gh stack view --json`: require valid `trunk`, `currentBranch`, and ordered `branches` with required layer fields. Only if view specifically reports “not part of a stack”, try `gh stack checkout <parent-pr-url>`; only if checkout specifically reports the same, run `gh stack init --base <parent-pr-base> <parent-branch>`. Propagate all other errors, then re-read valid stack state.
4. Require the current parent to equal `view.currentBranch` and be the final/top branch, neither merged nor queued. Ignore `needsRebase`; never run `gh stack sync`.
5. Refresh relevant origin refs and validate active layers in order, skipping merged/queued history. Starting at `view.trunk`, each active layer must have a PR number, local SHA equal its origin SHA, exactly one same-owner open PR from the lookup above, a matching PR number, and base equal the preceding active branch (trunk for the first). Stop on mismatch; suggest `gh stack push` for unpublished commits or `gh stack submit` for missing/mischained PRs.
6. Snapshot all active local/remote SHAs and the parent's number, title, body, base, head, owner, state, and URL. Resolve child wording and a fresh `type/slug` branch; fail if that exact name exists locally or remotely.

## Create child

Immediately before mutation, repeat the parent lookup; require unchanged number/head/base/owner/open state and inspected parent HEAD.

Run `gh stack add <child>`. Require checkout of the child with HEAD still equal the inspected parent HEAD and intended dirty work preserved. Commit only child work; require the commit's parent to equal that HEAD. Push only the child explicitly.

Create its PR with explicit `--base <parent-branch> --head <child> --title <child-title> --body-file <file>`. Re-read via exact same-owner lookup and require one open child PR with expected title/body/base/head.

## Submit and verify

Add the child's local/remote SHA to the snapshot and verify all expected SHAs immediately before `gh stack submit --auto`. After submission, require:

- Current branch remains the child and all snapshotted local/remote SHAs are unchanged.
- Parent metadata, including state/URL, is entirely unchanged.
- Child title/body/base/head/owner/open state/URL matches the created PR.
- `gh api repos/OWNER/REPO/stacks?pull_request=<child-number>` returns exactly one stack whose ordered `pull_requests` places the parent immediately before the child and the child last.

On failure after add, inspect/report the actual child branch, commit, push, and PR state as a failure with manual recovery guidance. Do not automatically delete, close, reset, rewrite, or reuse partial state.
