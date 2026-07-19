# Changelog rules

## Goal

Changelogs should show that products are moving without turning every release into forced marketing.

GitHub Releases are internal shipping records. Public changelog/social text is derived from PR changelog summaries and must stand alone because repositories may be private.

## PR title format

Every PR title should start with exactly one change type. The title format depends on the repository's package layout:

- Single-package repository or workspace: `type: description`
- Multi-package workspace: `type(package): description`

The supported change types are:

- `feat` — new user-facing capability
- `fix` — user-facing bug fix
- `improve` — user-facing refinement, UX, performance, or reliability improvement
- `internal` — infra, CI, tooling, refactor, tests, dependencies, logging, or other non-user-facing work

These types express release intent. They are not Conventional Commits.

## Package scope rules

- First inspect the repository's workspace configuration and package roots. Count distinct package roots declared by the workspace configuration or its ecosystem equivalent. If there is no formal workspace configuration, count independently built or published package roots identified by the repository's manifests.
- A private root manifest used only to coordinate workspace tooling does not count as a package. A root that is itself an independently built or published package does count.
- If the repository contains zero or one package root, omit the scope. If it contains two or more, treat it as a multi-package workspace.
- In a multi-package workspace, use the primary package's workspace directory basename as the scope. For example, work primarily in `packages/renderer` uses `renderer` even if its manifest name is `@example/pi-renderer`.
- Determine the primary package from the PR's intent and the full branch diff against the detected PR base. Resolve the title from the resulting branch after the current change is committed, not from only the previous branch state, current worktree, or latest commit.
- Incidental shared-file changes, such as a root lockfile updated alongside one package, do not override a clear primary package.
- When multi-package work is root-only, cross-cutting, or has no clear primary package, use `monorepo`.
- Use exactly one scope. Do not list several package names.

Examples:

- Single-package repository: `feat: add branded end cards for free exports`
- Primary package: `fix(renderer): prevent hidden tracks from rendering`
- Cross-cutting multi-package work: `internal(monorepo): centralize release deployment workflow`

## Commit message format

Commit messages always remain unscoped, regardless of repository layout:

- `feat: add branded end cards for free exports`
- `fix: prevent hidden tracks from rendering`
- `internal: centralize release deployment workflow`

Do not add package scopes to commit messages and do not rewrite existing commits merely to match a PR title.

## Change type rules

- `feat` means users can do something new.
- `fix` means a user-visible bug or broken behavior was corrected.
- `improve` means an existing user-facing workflow became clearer, faster, smoother, more reliable, or easier to use.
- `internal` means the work may matter to development/release/reliability but is not a public product change.

Do not use `fix` for technical-only fixes. Use `internal` for TypeScript fixes, build fixes, CI fixes, test fixes, dependency fixes, refactor corrections, and internal error handling unless the corrected behavior is directly user-visible.

## PR titles vs public summaries

PR titles are classification, package, and review metadata. They are not the public changelog source.

Good PR titles are concrete:

- `feat: add branded end cards for free exports`
- `fix(renderer): prevent hidden tracks from rendering`
- `improve(editor): speed up waveform rendering for long projects`
- `internal(monorepo): centralize release deployment workflow`

Avoid vague value-prop titles:

- `feat: help users create better results`
- `improve(editor): improve editor experience`
- `fix(renderer): make rendering better`

## PR changelog section

Every PR body should include:

```md
## Changelog

Public summary:

- ...

Context:

- ...
```

For `feat`, `fix`, and `improve`, `Public summary` should contain one specific standalone user-facing sentence. Write it as if it may become one bullet in a public release post.

For `internal`, write exactly:

```md
Public summary:

- None.
```

`Context` can include product/business details that help future release generation. It may be internal.

## Public changelog source priority

Release changelog generation should use sources in this order:

1. PR body `## Changelog` → `Public summary`
2. PR body `## Changelog` → `Context`
3. GitHub Release body
4. PR title, only for classification or fallback
5. Commit messages, only as a last fallback

If `Public summary` is `None`, skip that PR for public changelog output unless there is clear user-visible impact elsewhere in the release notes.

Package scopes in PR titles are metadata only. Do not copy them into public changelog text; use the canonical public summary instead.

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
