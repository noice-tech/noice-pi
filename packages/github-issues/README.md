# @noice-tech/pi-github-issues

Pick a GitHub issue and start a focused Pi planning session.

## Install

```bash
pi install -l npm:@noice-tech/pi-github-issues
```

## Use

| Command         | What it does                                                 |
| --------------- | ------------------------------------------------------------ |
| `/plan-issue`   | Opens a searchable picker with issues assigned to you.       |
| `/plan-issue 6` | Opens issue `6` directly. Use a positive number without `#`. |

The picker loads up to 1,000 open issues. Search by number or title, press Tab to show all open issues, Enter to select, or Escape to cancel.

After selection, the extension names the session `#<number> — <issue title>` and starts a turn with `Let’s plan solving issue #<number> from GitHub.`

It does not inject the issue body or enable a special planning mode. The agent can inspect the issue with `gh` as needed.

## Requirements

- [GitHub CLI](https://cli.github.com/) installed and authenticated with `gh auth login`
- A GitHub repository checkout
- Pi's interactive TUI when `/plan-issue` has no number
