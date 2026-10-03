# PR metadata

PR titles are concrete classification/review metadata. The canonical public changelog source is `## Changelog` → `Public summary`, not the title.

Write the final markdown body to a temporary file. Create with `gh pr create --body-file`, never `--body`. Update existing PRs through `gh api repos/OWNER/REPO/pulls/NUMBER -X PATCH --input <json-file>`, replacing only title/body; avoid `gh pr edit` because of deprecated Projects Classic queries.

Preserve useful existing sections, notes, checklists, media, linked issues, and verification; change stale content only when the branch proves it inaccurate. Ensure these sections exist:

```md
## Summary

- What this PR changes.

## Changelog

Public summary:

- One standalone user-facing sentence, or None., as required by the format policy.

Context:

- Useful context for future release generation.

## Verification

- Checks actually run, or Not run.
```
