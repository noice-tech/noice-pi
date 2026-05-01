# @noice-tech/pi-release-notes

Noice Tech Pi package for release notes-aware commit, PR, and public release copy workflows.

## What it installs

- `/commit` extension command that commits current changes and creates/updates the GitHub PR using Noice changelog rules.
- `/release-changelog` prompt template that generates public release notes/social copy from GitHub releases or tag ranges.
- `/setup-release-notes-style` prompt template that helps create repo-specific release notes voice and formatting guidance for `/release-changelog`.

## Install in a repo

```bash
pi install -l git:git@github.com:noice-tech/pi-release-notes.git@main
```

This writes the package to project `.pi/settings.json`. Commit that file so Pi auto-installs the package for everyone who opens the repo.

Expected project settings:

```json
{
  "packages": [
    "git:git@github.com:noice-tech/pi-release-notes.git@main"
  ]
}
```

## Commands

```txt
/commit [auto|feat|fix|improve|internal|ignore] [optional context]
/release-changelog <version | from..to>
/setup-release-notes-style [product/audience/channel notes]
```

Examples:

```txt
/commit improve speed up editor boot by lazy-loading templates
/release-changelog 5.0.2..5.0.5
/setup-release-notes-style Discord and X, concise, friendly, existing users of Noice
```

## Changelog rules

The canonical rules live in `extensions/changelog/rules.md`.

The `/commit` command embeds those rules into the worker prompt at runtime. The `/release-changelog` prompt repeats the relevant rules because Pi prompt templates are static markdown.

These package rules define the shared workflow across `/commit` and `/release-changelog`:

- change types: `feat:`, `fix:`, `improve:`, `internal:`, `ignore:`
- what counts as user-facing
- PR changelog section format
- source priority for release generation
- privacy constraints for public output

## Per-repo release notes style

Repos can add product-specific release notes style guidance for humans and for `/release-changelog` at:

```txt
docs-for-devs/release-notes-style.md
```

Use this file for repo-specific editorial guidance, such as:

- audience
- brand language and tone
- product terminology
- social media format
- emoji conventions
- bullet style
- examples of good and bad public release notes copy

The `/release-changelog` prompt checks for repo-specific instructions in this order:

1. `docs-for-devs/release-notes-style.md`
2. `.pi/release-notes-style.md`
3. a README section named `Release notes style`, `Release changelog style`, or `Changelog style`

Repo-specific instructions may define voice and public-output formatting, but they should not override the package rules for change classification, source priority, privacy, or excluding internal implementation details.

Without repo-specific instructions, `/release-changelog` uses a minimal default public format: only a plain Markdown bullet list of public summaries.

Suggested repo README link:

```md
## Release notes style

Humans and `/release-changelog` should follow
[docs-for-devs/release-notes-style.md](docs-for-devs/release-notes-style.md).
```

Suggested `docs-for-devs/release-notes-style.md` starter:

```md
# Release notes style

These instructions are for humans and for `/release-changelog`.

## Audience

Write for existing users of <Product> reading updates on Discord and X.

## Voice

Use:
- direct, concrete language
- short sentences
- a confident but not hypey tone

Avoid:
- startup marketing language
- vague claims like “better experience”
- internal implementation details

## Product language

Use:
- “<preferred term>” instead of “<internal term>”

Avoid:
- internal codenames
- backend/system terms

## Bullet style

Bullets should be:
- one sentence each
- specific
- user-facing
- short enough for social posts

Good:
- You can now export clips with branded end cards.
- Hidden tracks no longer appear in exported videos.

Bad:
- Improved export experience.
- Fixed renderer bug.
```
