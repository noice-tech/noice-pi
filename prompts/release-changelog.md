---
description: generate public changelog/social copy from a GitHub release or release range
argument-hint: "<version | from..to>"
---

Generate a public changelog/social post for the requested GitHub release or release range.

Input:
`$ARGUMENTS`

First, check for repo-specific release changelog instructions.

Look for these files/sections in this order:

1. `docs-for-devs/release-changelog.md`
2. `.pi/release-changelog.md`
3. a README section named `Release changelog style`, `Changelog style`, or `Release notes style`

If any exist, read them before writing the public post. Treat them as repo-specific editorial guidance for audience, brand language, product terminology, social formatting, examples, emoji use, and bullet style.

Repo-specific instructions may refine tone and formatting, but they must not override the package changelog rules below about source priority, change classification, privacy, or excluding internal implementation details.

Follow these shared changelog rules exactly:

- PR title prefixes: `feat:`, `fix:`, `improve:`, `internal:`, `ignore:`.
- `feat:` means users can do something new.
- `fix:` means a user-visible bug or broken behavior was corrected.
- `improve:` means an existing user-facing workflow became clearer, faster, smoother, more reliable, or easier to use.
- `internal:` means the work may matter to development/release/reliability but is not a public product change.
- `ignore:` means the work should not appear in release or public changelog narratives.
- Do not use technical-only fixes as public fixes. TypeScript, build, CI, test, dependency, refactor, and internal error-handling fixes are `internal:` unless the corrected behavior is directly user-visible.
- PR titles are classification/review metadata. They are not the public changelog source.
- PR body `## Changelog` → `Public summary` is the canonical public changelog atom.

The input may be:

- a single version/tag, e.g. `5.0.5` or `v5.0.5`
- a range, e.g. `5.0.2..5.0.5` or `v5.0.2..v5.0.5`

Resolve versions to Git tags. Accept both bare versions and `v`-prefixed tags.

Use `gh` and `git` to inspect the requested release/range:

- GitHub release body/bodies
- previous/current tags as needed
- merged PRs included in the release or range
- PR titles and PR bodies

Public changelog source priority:

1. PR body `## Changelog` → `Public summary`
2. PR body `## Changelog` → `Context`
3. GitHub Release body
4. PR title, only for classification or fallback
5. Commit messages, only as a last fallback

Do not treat PR titles as public summaries. PR titles classify the work; PR body `Public summary` is the canonical public changelog atom.

Include only meaningful user-facing changes:

- use `feat:`, `fix:`, and `improve:` PRs when their `Public summary` is not `None`
- skip `internal:` and `ignore:` PRs by default
- skip PRs where `Public summary` is `None`
- be conservative with `fix:`: include only user-visible fixes, not technical/build/CI/test/refactor/dependency fixes

Public output constraints:

- no GitHub links
- no release links
- no PR numbers
- no commit hashes
- no private URLs
- no internal implementation details
- same text should work for Discord and X
- make the product feel alive and actively improving
- do not force hype
- avoid generic phrases like `improved experience`, `seamless`, `empower`, or `game-changing`

Output format:

1. Public post, ready to copy.
2. Internal source notes.

Public post format:

```md
:sparkles: **Update — <version or from → to>**

<one short intro sentence>

- <specific public change>
- <specific public change>
- <specific public change>
```

If there are no meaningful public changes, output exactly this as the public post:

```txt
No public changelog suggested for this release.
```

Internal source notes format:

```md
Internal source notes:

Used:

- <PR number/title or release source>

Ignored:

- <PR number/title and reason>

Potential authored product update: yes/no
Reason: <short reason>
```

Keep the public post free of private artifacts. Internal source notes may include PR numbers/titles because they are for private review only.
