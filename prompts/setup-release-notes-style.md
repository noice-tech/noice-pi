---
description: create or refine repo-specific release notes voice and formatting guidance
argument-hint: "[product/audience/channel notes]"
---

Create or refine this repository's repo-specific release notes style file:

`docs-for-devs/release-notes-style.md`

Input notes from the user:
`$ARGUMENTS`

Goal:

Write guidance for humans and for `/release-changelog` that defines this product's public release notes voice, audience, terminology, and formatting.

Important boundary:

Do not duplicate the package's core changelog rules. Do not write instructions about:

- PR title prefixes such as `feat:`, `fix:`, `improve:`, `internal:`, or `ignore:`
- how to classify changes
- how to inspect GitHub releases, PRs, tags, commits, or release ranges
- source priority between PR bodies, release bodies, titles, and commits
- internal source notes
- privacy rules such as excluding PR numbers, commit hashes, GitHub links, or private URLs
- requiring `## Changelog`, `Public summary`, or `Context` sections in PR bodies

Those are owned by the `@noice-tech/pi-release-notes` package. This file should only define repo/product-specific editorial guidance.

Process:

1. Inspect the repository README and any existing product/docs files that help infer audience, product language, and public tone.
2. If `docs-for-devs/release-notes-style.md` already exists, read it and refine it instead of replacing useful guidance.
3. Create `docs-for-devs/` if needed.
4. Write a concise, practical `docs-for-devs/release-notes-style.md`.
5. If the README does not already link to the file, suggest adding a short link section, but do not add it unless the user asked for README changes.

The voice file should usually include:

```md
# Release notes style

These instructions are for humans and for `/release-changelog`.

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

Keep it short. Prefer concrete examples over abstract writing advice. If you cannot infer product-specific details, leave clear placeholders like `<Product>` or ask a brief follow-up before writing.
