# Changelog rules

## Goal

Changelogs should show that products are moving without turning every release into forced marketing.

GitHub Releases are internal shipping records. Public changelog/social text is derived from PR changelog summaries and must stand alone because repositories may be private.

## PR title prefixes

Every PR title should start with exactly one prefix:

- `feat:` new user-facing capability
- `fix:` user-facing bug fix
- `improve:` user-facing refinement, UX, performance, or reliability improvement
- `internal:` infra, CI, tooling, refactor, tests, dependencies, logging, or other non-user-facing work
- `ignore:` no release/changelog value

These prefixes are release intent, not conventional commits.

## Prefix rules

- `feat:` means users can do something new.
- `fix:` means a user-visible bug or broken behavior was corrected.
- `improve:` means an existing user-facing workflow became clearer, faster, smoother, more reliable, or easier to use.
- `internal:` means the work may matter to development/release/reliability but is not a public product change.
- `ignore:` means the work should not appear in release or public changelog narratives.

Do not use `fix:` for technical-only fixes. Use `internal:` for TypeScript fixes, build fixes, CI fixes, test fixes, dependency fixes, refactor corrections, and internal error handling unless the corrected behavior is directly user-visible.

## PR titles vs public summaries

PR titles are classification and review metadata. They are not the public changelog source.

Good PR titles are concrete:

- `feat: add branded end cards for free exports`
- `fix: prevent hidden tracks from rendering`
- `improve: speed up waveform rendering for long projects`
- `internal: centralize release deployment workflow`
- `ignore: refactor timeline test helpers`

Avoid vague value-prop titles:

- `feat: help users create better results`
- `improve: improve editor experience`
- `fix: make rendering better`

## PR changelog section

Every PR body should include:

```md
## Changelog

Public summary:

- ...

Context:

- ...
```

For `feat:`, `fix:`, and `improve:`, `Public summary` should contain one specific standalone user-facing sentence. Write it as if it may become one bullet in a public release post.

For `internal:` and `ignore:`, write exactly:

```md
Public summary:

- None.
```

`Context` can include product/business details that help future release generation. It may be internal. For `ignore:`, use `None.`

## Public changelog source priority

Release changelog generation should use sources in this order:

1. PR body `## Changelog` → `Public summary`
2. PR body `## Changelog` → `Context`
3. GitHub Release body
4. PR title, only for classification or fallback
5. Commit messages, only as a last fallback

If `Public summary` is `None`, skip that PR for public changelog output unless there is clear user-visible impact elsewhere in the release notes.

## Public changelog output rules

Public changelog/social text:

- must not link to GitHub, PRs, commits, releases, or private repo artifacts
- must not include PR numbers, commit hashes, or private URLs
- should be standalone and understandable without release links
- should use only meaningful user-facing changes
- should make the product feel actively improved
- should not force hype or flexing
- should not include internal implementation details
- should avoid generic phrases like `improved experience`, `seamless`, `empower`, and `game-changing`

The same text should work for Discord and X.

## GitHub Releases vs public changelog vs updates

- GitHub Release: internal factual shipping record.
- Public changelog/social post: short movement signal derived from public summaries.
- Authored product update: bigger product story with screenshots/video/narrative when a release has enough substance.

Not every release needs an authored product update.
