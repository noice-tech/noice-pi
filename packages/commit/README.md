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
```

| Command                            | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `/commit [type] [summary]`         | Commits and pushes, then creates or updates the pull request.     |
| `/commit --no-pr [type] [summary]` | Commits and pushes without reading or changing a pull request.    |
| `/commit stacked [type] [summary]` | Creates a child branch and PR above the current branch's open PR. |

Add `--pr` to override no-PR configuration for one run. Leave out the type, or use `auto`, to let the model infer it. A supplied summary is the primary wording source and is checked against the current diff.

`/commit` is a prompt template that runs in your active conversation. A small extension enables Codemode, validates options and trusted configuration, and supplies the format policy and only the selected workflow (normal PR, no-PR, or stacked). Codemode filters command noise before it reaches the model; relevant evidence and the final branch, commit, push, PR, and remaining-worktree state stay in context for the next coding turn.

Commit authorization ends after the result. The model is instructed not to commit, push, or change PR metadata again without fresh explicit user authorization. This is a behavioral instruction, not a permission system. There is no worker branch, context filtering, interactive type picker, or custom argument completion; Pi's normal input/steering behavior applies.

## Defaults

The built-in types are `feat`, `fix`, `improve`, and `internal`. Commits use `type: description`; PR titles add a package scope only in multi-package workspaces. PR bodies contain stable Summary, Changelog, and Verification sections. Internal changes receive no public changelog summary.

## Configure

Configuration is optional. Create a JSON file in either location:

| Scope   | Path                         | Use it for                                       |
| ------- | ---------------------------- | ------------------------------------------------ |
| User    | `~/.pi/agent/pi-commit.json` | Defaults across your projects.                   |
| Project | `.pi/pi-commit.json`         | Shared repository defaults in a trusted project. |

Settings are merged individually: project values override user values, which override the built-in defaults. `/commit` flags such as `--pr` and `--no-pr` override configuration for one run. Project configuration is ignored until the project is trusted.

### Pull request behavior

To push commits without creating or updating pull requests by default:

```json
{
  "pullRequest": "never"
}
```

`pullRequest` accepts `"auto"` (the default) or `"never"`.

### Commit format

The default opinionated format uses `feat`, `fix`, `improve`, and `internal`. You can state it explicitly:

```json
{
  "format": "opinionated"
}
```

Or replace it with project-specific change types:

```json
{
  "format": {
    "changeTypes": [
      { "name": "docs", "description": "Documentation", "public": true },
      { "name": "chore", "description": "Maintenance", "public": false }
    ],
    "instructions": "Use type(scope): description."
  }
}
```

Each change type needs:

- `name` — a unique lowercase identifier using letters, digits, and hyphens; `auto` and `stacked` are reserved
- `description` — guidance for classifying and applying the type
- `public` — whether the model must write a standalone public changelog summary; non-public types write `None.`

`instructions` tells the model how to format commit and PR titles. It cannot override the commit workflow or public-summary rules.

You may combine both settings in one file. Unknown fields, malformed JSON, and invalid values stop `/commit` before any Git or GitHub changes.

## Requirements

- Pi 1.0 or newer, with its built-in Codemode extension available and Bash active
- Git and a remote you can push to
- PR mode: authenticated [GitHub CLI](https://cli.github.com/)
- Stacked mode: the [`github/gh-stack`](https://github.com/github/gh-stack) extension

Every commit mode pushes. PR mode can create or update a pull request. Stacked mode must start from the published top of a valid stack and can leave a branch, commit, push, or PR behind if a later step fails; the model reports any partial state.

The workflow sends relevant session and repository context to your selected model. Review your model provider's privacy settings before using it with sensitive code.
