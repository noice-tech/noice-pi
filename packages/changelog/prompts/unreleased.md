---
description: preview unreleased changelog candidates since the latest git tag
argument-hint: ''
---

Preview what would go into a new release from merged PRs since the latest git tag. Do not create tags, releases, commits, branches, PRs, or files. Reply directly in chat only.

Input:
`$ARGUMENTS`

Ignore arguments if provided. This command previews the current unreleased state only.

Follow these shared changelog rules exactly:

- Valid PR titles use either unscoped `type: description` or package-scoped `type(package): description` form.
- The change types are `feat`, `fix`, `improve`, and `internal`.
- `feat` means users can do something new.
- `fix` means a user-visible bug or broken behavior was corrected.
- `improve` means an existing user-facing workflow became clearer, faster, smoother, more reliable, or easier to use.
- `internal` means the work may matter to development/release/reliability but is not a public product change.
- Do not use technical-only fixes as public fixes. TypeScript, build, CI, test, dependency, refactor, and internal error-handling fixes are `internal` unless the corrected behavior is directly user-visible.
- A package scope, including `monorepo`, is metadata. It does not change the change type and must not be copied into public changelog text.
- PR titles are classification/review metadata. They are not the public changelog source.
- PR body `## Changelog` → `Public summary` is the canonical public changelog atom.

Workflow:

1. Run `git fetch --tags`.
2. Find the latest reachable tag with `git describe --tags --abbrev=0`.
3. Get the latest tag commit date with `git log -1 --format=%cI <latest-tag>`.
4. Inspect commits since the latest tag with `git log --oneline <latest-tag>..HEAD`.
5. Use `gh` to find merged PRs after the latest tag commit date, normally with `gh pr list --state merged --search "merged:>=YYYY-MM-DD" --json number,title,url,mergedAt,body,mergeCommit,headRefName,baseRefName`.
6. Cross-check the PRs against commits in `<latest-tag>..HEAD` when possible. If matching is uncertain, say so in the preview.
7. For each relevant PR, read the title and body. Use `gh pr view` for full details if needed.
8. Extract the PR body `## Changelog` section, especially:
   - `Public summary:`
   - `Context:`
9. Classify each PR as:
   - public candidate
   - internal/skipped
   - needs cleanup
10. Reply directly with the preview. Do not write a file.

Public candidate rules:

- Include `feat`, `fix`, and `improve` PRs, whether scoped or unscoped, when `Public summary` contains a meaningful user-facing summary.
- Skip `internal` PRs by default, whether scoped or unscoped.
- Skip PRs where `Public summary` is `None`.
- Be conservative with `fix`. Include only user-visible fixes, not technical/build/CI/test/refactor/dependency fixes.
- Use `Public summary` text as the candidate release bullet when available.
- If the PR appears user-facing but lacks a usable public summary, put it under `Needs cleanup`, not `Public candidates`.

Needs cleanup rules:

Flag PRs that may affect release quality, especially:

- missing `## Changelog` section
- missing `Public summary`
- vague public summary such as “Improved experience” or “Bug fixes”
- `feat`, `fix`, or `improve` PR, whether scoped or unscoped, with `Public summary: None`
- title change type appears inconsistent with the changelog body
- possible user-facing change only discoverable from title/commits, not from `Public summary`

Output format:

```md
Unreleased preview since <latest-tag>

Release recommendation: <yes|maybe|no>

Public candidates: <count>
Internal/skipped: <count>
Needs cleanup: <count>

## Public candidates

- <public summary>
  Source: #<number> <title>

## Internal / skipped

- #<number> <title>
  Reason: <reason>

## Needs cleanup

- #<number> <title>
  Issue: <issue>

## Recommendation

<short recommendation explaining whether this looks worth releasing now and what, if anything, should be cleaned up first.>

## Notes

- <include uncertainty about PR matching, no latest tag, no GitHub CLI access, or no unreleased commits only when relevant>
```

If there is no latest tag, say that an unreleased preview cannot be anchored to a previous release and summarize recent merged PRs only if safe.

If there are no commits or PRs since the latest tag, recommend `no` and say there is nothing new to release.

Keep the preview raw and factual. Do not generate polished public/social release notes. Do not include a title, CTA, or marketing framing beyond the required format.
