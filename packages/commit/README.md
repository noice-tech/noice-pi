# @noice-tech/pi-commit

Commit, push, and open pull requests without interrupting your Pi session.

## Install

Run this in the repository where you use Pi:

```bash
pi install -l npm:@noice-tech/pi-commit
```

Commit the resulting `.pi/settings.json` change to install it for collaborators too.

## Use

```text
/commit fix prevent hidden tracks from rendering
/commit --no-pr internal refresh test fixtures
/commit stacked feat add export presets
/commit-config
```

| Command                            | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `/commit [type] [summary]`         | Commits and pushes, then creates or updates the pull request.     |
| `/commit --no-pr [type] [summary]` | Commits and pushes without reading or changing a pull request.    |
| `/commit stacked [type] [summary]` | Creates a child branch and PR above the current branch's open PR. |
| `/commit-config`                   | Configures PR behavior and commit types for the user or project.  |

Add `--pr` to override no-PR configuration for one run. Leave out the type to choose it interactively, or use `auto` to let the worker infer it. A supplied summary is the primary wording source and is checked against the current diff.

`/commit` runs its worker on a separate branch of Pi's session tree, so commit and PR work does not consume your active coding context. You return to the same conversation, and the worker transcript remains available in the session tree.

## Defaults

The built-in types are `feat`, `fix`, `improve`, and `internal`. Commits use `type: description`; PR titles add a package scope only in multi-package workspaces. PR bodies contain stable Summary, Changelog, and Verification sections. Internal changes receive no public changelog summary.

## Configure

`/commit-config` edits either `~/.pi/agent/pi-commit.json` or the trusted project's `.pi/pi-commit.json`. Project settings override user settings; command flags override both.

Use `"pullRequest": "never"` to skip PRs by default. Keep the opinionated format or define your own types:

```json
{
  "pullRequest": "never",
  "format": {
    "changeTypes": [
      { "name": "docs", "description": "Documentation", "public": true },
      { "name": "chore", "description": "Maintenance", "public": false }
    ],
    "instructions": "Use type(scope): description."
  }
}
```

A public type requires a standalone changelog summary; a non-public type writes `None.`. Invalid configuration stops before any Git or GitHub changes.

## Requirements

- Git and a remote you can push to
- PR mode: authenticated [GitHub CLI](https://cli.github.com/) and `jq`
- Stacked mode: the [`github/gh-stack`](https://github.com/github/gh-stack) extension

Every commit mode pushes. PR mode can create or update a pull request. Stacked mode must start from the published top of a valid stack and can leave a branch, commit, push, or PR behind if a later step fails; the worker reports any partial state.

The worker sends relevant session and repository context to your selected model. Review your model provider's privacy settings before using it with sensitive code.
