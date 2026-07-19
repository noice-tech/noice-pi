---
description: generate public release notes/social copy from a GitHub release or release range
argument-hint: '<version | from..to>'
---

Generate public release notes/social copy for the requested GitHub release or release range, and write public copy and private review sources to separate Markdown files.

Input:
`$ARGUMENTS`

## Output files

Derive `<slug>` from `$ARGUMENTS` by trimming surrounding whitespace, quotes, and backticks; keeping letters, numbers, dots, underscores, and hyphens; replacing every other character (including spaces and slashes) with `-`; collapsing repeated hyphens; and using `release-notes` if the result is empty.

Create or overwrite both files:

- public copy: `release-notes/<slug>.md`
- private review sources: `.pi/tmp/pi-changelog/release-notes-sources/<slug>.md`

Treat `.pi/tmp/` as ephemeral private workspace data that should remain ignored by Git and unpublished. Do not edit or create the consumer repository's `.gitignore`; only write the requested output files. Never put private source notes in the public artifact. After writing both files, reply only with both paths and a one-sentence summary of what was written.

## Repository-specific style

If `.pi/release-notes-style.md` exists, read it before writing public copy. It is the only canonical repository-specific style convention. It may refine audience, voice, terminology, formatting, examples, emoji use, and bullet style, but it must not override the classification, source-priority, or privacy rules below.

## Shared changelog rules

Valid PR titles use either unscoped `type: description` or package-scoped `type(package): description` form. The change types are `feat`, `fix`, `improve`, and `internal`.

- `feat` means users can do something new.
- `fix` means a user-visible bug or broken behavior was corrected.
- `improve` means an existing user-facing workflow became clearer, faster, smoother, more reliable, or easier to use.
- `internal` means the work may matter to development, release, or reliability but is not a public product change.
- Technical-only TypeScript, build, CI, test, dependency, refactor, and internal error-handling fixes are `internal` unless corrected behavior is directly user-visible.
- A package scope, including `monorepo`, is metadata. It does not change the change type and must not be copied into public changelog text.
- PR titles classify work; they are not the public changelog source.
- PR body `## Changelog` → `Public summary` is the canonical public changelog atom.

The input can be a single version/tag or a `from..to` range. Resolve bare and `v`-prefixed versions to Git tags. Use `gh` and `git` to inspect GitHub release bodies, tags, included merged PRs, and their titles and bodies.

Use sources in this order:

1. PR body `## Changelog` → `Public summary`
2. PR body `## Changelog` → `Context`
3. GitHub Release body
4. PR title, only for classification or fallback
5. Commit messages, only as a last fallback

Include meaningful `feat`, `fix`, and `improve` changes, whether scoped or unscoped, whose public summary is not `None`. Skip `internal` changes and summaries of `None`. Be conservative with fixes.

## Public copy

The public file must contain no GitHub or release links, PR numbers, commit hashes, private URLs, private artifact references, internal source notes, or implementation details. It must stand alone.

Follow `.pi/release-notes-style.md` when present. Otherwise write only a plain Markdown bullet list of specific public summaries, with no heading, intro, version line, emoji, CTA, links, or social framing.

If there are no meaningful public changes, write exactly:

```text
No public changelog suggested for this release.
```

## Private review sources

Write source review details only to `.pi/tmp/pi-changelog/release-notes-sources/<slug>.md` in this format:

```md
# Internal source notes

Used:

- <PR number/title or release source>

Skipped:

- <PR number/title and reason>

Potential authored product update: yes/no
Reason: <short reason>
```
