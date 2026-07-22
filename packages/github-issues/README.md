# @noice-tech/pi-github-issues

A focused [Pi](https://github.com/earendil-works/pi) extension for starting an ordinary agent turn to plan a GitHub issue.

## Install

```bash
pi install npm:@noice-tech/pi-github-issues
```

Commit the resulting `.pi/settings.json` change when collaborators should use the package too.

## Prerequisites and trust

The extension requires:

- [GitHub CLI](https://cli.github.com/) (`gh`)
- an authenticated GitHub CLI session (`gh auth login`)
- a GitHub repository checkout

Pi extensions run with Pi's full system permissions. Only install packages you trust. This extension invokes `gh` to resolve the current repository and read issue metadata.

## Command

```text
/plan-issue
/plan-issue 6
```

With no argument, `/plan-issue` loads up to 1,000 open issues into a searchable TUI picker. The default **Assigned to me** scope uses the authenticated GitHub CLI user (`--assignee @me`) as a task queue. Press Tab to switch to **All open issues**, and type to filter by issue number or title.

Passing a positive issue number bypasses the picker and resolves that issue directly through `gh`.

After selection, the extension:

1. names the Pi session `#<number> — <issue title>`; and
2. starts a normal agent turn with `Let’s plan solving issue #<number> from GitHub.`

The extension does not add the issue body or other fetched details to model context, change the active tools, or enable a special planning mode. The agent can use `gh` itself to inspect the issue. Cancelling the picker leaves the session name and conversation unchanged.

## License

[MIT](./LICENSE)
