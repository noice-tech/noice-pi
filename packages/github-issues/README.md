# @noice-tech/pi-github-issues

Pick a GitHub issue and turn it into a named Pi planning session in one command.

## Install

```bash
pi install npm:@noice-tech/pi-github-issues
```

## Commands

| Command         | What it does                                                                    |
| --------------- | ------------------------------------------------------------------------------- |
| `/plan-issue`   | Opens a searchable TUI picker, showing issues assigned to you by default.       |
| `/plan-issue 6` | Opens issue `6` directly without the picker. Use a positive number without `#`. |

The picker loads up to 1,000 open issues. Type to search by number or title, press Tab for all open issues, Enter to select, or Escape to cancel.

After selection, the extension:

1. names the session `#<number> — <issue title>`; and
2. starts a turn with `Let’s plan solving issue #<number> from GitHub.`

It does not inject the issue body, change tools, or enable a special planning mode. The agent can inspect the issue with `gh` as needed.

## Requirements

- [GitHub CLI](https://cli.github.com/) installed and authenticated with `gh auth login`
- a GitHub repository checkout
- TUI mode when `/plan-issue` has no number
