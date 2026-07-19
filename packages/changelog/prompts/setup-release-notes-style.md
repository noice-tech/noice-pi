---
description: create or refine repo-specific release notes voice and formatting guidance
argument-hint: '[product/audience/channel notes]'
---

Create or refine the repository's only canonical release notes style file:

`.pi/release-notes-style.md`

Input notes from the user:
`$ARGUMENTS`

Write concise guidance for humans and `/release-notes` that defines this product's public release notes audience, voice, terminology, and formatting.

Do not duplicate package-owned rules about `feat`, `fix`, `improve`, or `internal` classification; inspecting GitHub releases, PRs, tags, commits, or ranges; source priority; internal source notes; privacy; or PR body structure.

Process:

1. Inspect the repository README and product documentation for audience, language, and public tone.
2. If `.pi/release-notes-style.md` exists, refine it without replacing useful guidance.
3. Create `.pi/` if needed.
4. Write `.pi/release-notes-style.md`.
5. Reply with the path and a concise summary.

The style file should usually include:

```md
# Release notes style

These instructions are for humans and for `/release-notes`.

## Audience

<who the public changelog is for>

## Voice

Use:

- ...

Avoid:

- ...

## Product language

Use:

- ...

Avoid:

- ...

## Public format

<exact public output format for this repo/channel>

## Bullet style

Bullets should be:

- ...

## Examples

Good:

- ...

Bad:

- ...
```

Keep it short and prefer concrete examples. If product-specific details cannot be inferred, use clear placeholders such as `<Product>` or ask a brief follow-up before writing.
