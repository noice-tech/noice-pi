# @noice-tech/pi-changelog

Noice Tech Pi package for changelog-aware commit, PR, and release-note workflows.

## What it installs

- `/commit` extension command that commits current changes and creates/updates the GitHub PR using Noice changelog rules.
- `/release-changelog` prompt template that generates public changelog/social copy from GitHub releases or tag ranges.

## Install in a repo

```bash
pi install -l git:git@github.com:noice-tech/pi-changelog.git@main
```

This writes the package to project `.pi/settings.json`. Commit that file so Pi auto-installs the package for everyone who opens the repo.

Expected project settings:

```json
{
  "packages": [
    "git:git@github.com:noice-tech/pi-changelog.git@main"
  ]
}
```

## Commands

```txt
/commit [auto|feat|fix|improve|internal|ignore] [optional context]
/release-changelog <version | from..to>
```

Examples:

```txt
/commit improve speed up editor boot by lazy-loading templates
/release-changelog 5.0.2..5.0.5
```

## Changelog rules

The canonical rules live in `extensions/changelog/rules.md`.

The `/commit` command embeds those rules into the worker prompt at runtime. The `/release-changelog` prompt repeats the relevant rules because Pi prompt templates are static markdown.
