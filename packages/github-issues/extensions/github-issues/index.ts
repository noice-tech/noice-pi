import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme
} from '@earendil-works/pi-coding-agent'
import {
  fuzzyFilter,
  Input,
  truncateToWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI
} from '@earendil-works/pi-tui'

const GH_TIMEOUT_MS = 10_000
const ISSUE_LIMIT = 1_000
const MAX_VISIBLE_ISSUES = 10

export interface GitHubIssue {
  number: number
  title: string
}

type IssueScope = 'assigned' | 'all'

interface GhResult {
  code: number
  stdout: string
  stderr: string
  killed?: boolean
}

class GitHubIssuesError extends Error {}

export function filterIssues(
  issues: GitHubIssue[],
  rawQuery: string
): GitHubIssue[] {
  const query = rawQuery.trim().replace(/^#/, '')
  if (!query) return issues

  return fuzzyFilter(issues, query, (issue) => `${issue.number} ${issue.title}`)
}

function parseJson(raw: string, malformedMessage: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new GitHubIssuesError(malformedMessage)
  }
}

function parseRepository(raw: string): string {
  const parsed = parseJson(
    raw,
    'GitHub CLI returned malformed repository data.'
  )
  const nameWithOwner = (parsed as { nameWithOwner?: unknown })?.nameWithOwner

  if (
    typeof nameWithOwner !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)
  ) {
    throw new GitHubIssuesError(
      'GitHub CLI returned malformed repository data.'
    )
  }

  return nameWithOwner
}

function isGitHubIssue(value: unknown): value is GitHubIssue {
  if (!value || typeof value !== 'object') return false
  const issue = value as { number?: unknown; title?: unknown }
  return (
    Number.isSafeInteger(issue.number) &&
    (issue.number as number) > 0 &&
    typeof issue.title === 'string' &&
    issue.title.trim().length > 0
  )
}

function parseIssueList(raw: string, scope: string): GitHubIssue[] {
  const parsed = parseJson(
    raw,
    `GitHub CLI returned malformed ${scope} issue data.`
  )
  if (!Array.isArray(parsed) || !parsed.every(isGitHubIssue)) {
    throw new GitHubIssuesError(
      `GitHub CLI returned malformed ${scope} issue data.`
    )
  }
  return parsed
}

function parseIssue(raw: string, expectedNumber: number): GitHubIssue {
  const parsed = parseJson(
    raw,
    `GitHub CLI returned malformed data for issue #${expectedNumber}.`
  )
  if (!isGitHubIssue(parsed) || parsed.number !== expectedNumber) {
    throw new GitHubIssuesError(
      `GitHub CLI returned malformed data for issue #${expectedNumber}.`
    )
  }
  return parsed
}

function commandDetails(result: GhResult): string {
  const details = (result.stderr || result.stdout).trim().replace(/\s+/g, ' ')
  return details || `exit code ${result.code}`
}

async function executeGh(
  pi: ExtensionAPI,
  args: string[],
  cwd: string
): Promise<GhResult> {
  try {
    const result = await pi.exec('gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS
    })
    if (result.killed) {
      throw new GitHubIssuesError(
        `GitHub CLI timed out while running \`gh ${args.join(' ')}\`.`
      )
    }
    return result
  } catch (error) {
    if (error instanceof GitHubIssuesError) throw error
    const details = error instanceof Error ? error.message : String(error)
    throw new GitHubIssuesError(`Could not run GitHub CLI (gh): ${details}`)
  }
}

async function resolveRepository(
  pi: ExtensionAPI,
  cwd: string
): Promise<string> {
  const version = await executeGh(pi, ['--version'], cwd)
  if (version.code !== 0) {
    throw new GitHubIssuesError(
      'GitHub CLI (gh) is required but was not found. Install gh and try again.'
    )
  }

  const auth = await executeGh(pi, ['auth', 'status', '--active'], cwd)
  if (auth.code !== 0) {
    throw new GitHubIssuesError(
      'GitHub CLI is not authenticated. Run `gh auth login` and try again.'
    )
  }

  const result = await executeGh(
    pi,
    ['repo', 'view', '--json', 'nameWithOwner'],
    cwd
  )
  if (result.code !== 0) {
    const details = commandDetails(result)
    if (
      /not a git repository|no git remotes|none of the git remotes|unable to determine repository/i.test(
        details
      )
    ) {
      throw new GitHubIssuesError(
        'The current directory is not a GitHub repository. Run /plan-issue from a GitHub repository checkout.'
      )
    }
    throw new GitHubIssuesError(
      `Could not resolve the current GitHub repository: ${details}`
    )
  }

  return parseRepository(result.stdout)
}

async function loadOpenIssues(
  pi: ExtensionAPI,
  cwd: string,
  repository: string
): Promise<{ assigned: GitHubIssue[]; all: GitHubIssue[] }> {
  const commonArgs = [
    'issue',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--limit',
    String(ISSUE_LIMIT),
    '--json',
    'number,title'
  ]

  const assignedResult = await executeGh(
    pi,
    [...commonArgs, '--assignee', '@me'],
    cwd
  )
  if (assignedResult.code !== 0) {
    throw new GitHubIssuesError(
      `Failed to load issues assigned to you from ${repository}: ${commandDetails(assignedResult)}`
    )
  }
  const assigned = parseIssueList(assignedResult.stdout, 'assigned')

  const allResult = await executeGh(pi, commonArgs, cwd)
  if (allResult.code !== 0) {
    throw new GitHubIssuesError(
      `Failed to load open issues from ${repository}: ${commandDetails(allResult)}`
    )
  }
  const all = parseIssueList(allResult.stdout, 'open')

  if (all.length === 0) {
    throw new GitHubIssuesError(`No open GitHub issues found in ${repository}.`)
  }

  return { assigned, all }
}

async function loadIssue(
  pi: ExtensionAPI,
  cwd: string,
  repository: string,
  issueNumber: number
): Promise<GitHubIssue> {
  const result = await executeGh(
    pi,
    [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repository,
      '--json',
      'number,title,state,url'
    ],
    cwd
  )

  if (result.code !== 0) {
    throw new GitHubIssuesError(
      `Could not load issue #${issueNumber} from ${repository}: ${commandDetails(result)}`
    )
  }

  return parseIssue(result.stdout, issueNumber)
}

export class IssuePicker implements Component, Focusable {
  private readonly searchInput = new Input()
  private readonly assignedIssues: GitHubIssue[]
  private readonly allIssues: GitHubIssue[]
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly keybindings: KeybindingsManager
  private readonly done: (issue: GitHubIssue | null) => void
  private scope: IssueScope = 'assigned'
  private selectedIndex = 0
  private _focused = false

  constructor(
    assignedIssues: GitHubIssue[],
    allIssues: GitHubIssue[],
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (issue: GitHubIssue | null) => void
  ) {
    this.assignedIssues = assignedIssues
    this.allIssues = allIssues
    this.tui = tui
    this.theme = theme
    this.keybindings = keybindings
    this.done = done
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.searchInput.focused = value
  }

  invalidate(): void {
    this.searchInput.invalidate()
  }

  private get visibleIssues(): GitHubIssue[] {
    const issues =
      this.scope === 'assigned' ? this.assignedIssues : this.allIssues
    return filterIssues(issues, this.searchInput.getValue())
  }

  private changeSelection(offset: number): void {
    const issues = this.visibleIssues
    if (issues.length === 0) return
    this.selectedIndex =
      (this.selectedIndex + offset + issues.length) % issues.length
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, 'tui.select.cancel')) {
      this.done(null)
      return
    }

    if (this.keybindings.matches(data, 'tui.input.tab')) {
      this.scope = this.scope === 'assigned' ? 'all' : 'assigned'
      this.selectedIndex = 0
      this.tui.requestRender()
      return
    }

    if (this.keybindings.matches(data, 'tui.select.up')) {
      this.changeSelection(-1)
      this.tui.requestRender()
      return
    }

    if (this.keybindings.matches(data, 'tui.select.down')) {
      this.changeSelection(1)
      this.tui.requestRender()
      return
    }

    if (this.keybindings.matches(data, 'tui.select.pageUp')) {
      this.changeSelection(-MAX_VISIBLE_ISSUES)
      this.tui.requestRender()
      return
    }

    if (this.keybindings.matches(data, 'tui.select.pageDown')) {
      this.changeSelection(MAX_VISIBLE_ISSUES)
      this.tui.requestRender()
      return
    }

    if (this.keybindings.matches(data, 'tui.select.confirm')) {
      const issue = this.visibleIssues[this.selectedIndex]
      if (issue) this.done(issue)
      return
    }

    const previousQuery = this.searchInput.getValue()
    this.searchInput.handleInput(data)
    if (this.searchInput.getValue() !== previousQuery) {
      this.selectedIndex = 0
      this.tui.requestRender()
    }
  }

  render(width: number): string[] {
    if (width <= 0) return []

    const issues = this.visibleIssues
    if (this.selectedIndex >= issues.length) this.selectedIndex = 0

    const border = this.theme.fg('border', '─'.repeat(width))
    const assignedLabel =
      this.scope === 'assigned'
        ? this.theme.fg('accent', this.theme.bold('[Assigned to me]'))
        : this.theme.fg('muted', 'Assigned to me')
    const allLabel =
      this.scope === 'all'
        ? this.theme.fg('accent', this.theme.bold('[All open issues]'))
        : this.theme.fg('muted', 'All open issues')
    const inputWidth = Math.max(1, width - 7)
    const inputLine = this.searchInput.render(inputWidth)[0] ?? ''
    const lines = [
      border,
      truncateToWidth(
        this.theme.fg('accent', this.theme.bold('Plan a GitHub issue')),
        width,
        ''
      ),
      truncateToWidth(`Scope: ${assignedLabel}  ${allLabel}`, width, ''),
      truncateToWidth(`Search ${inputLine}`, width, '')
    ]

    if (issues.length === 0) {
      const message = this.searchInput.getValue()
        ? 'No issues match this search in the selected scope.'
        : this.scope === 'assigned'
          ? 'No open issues assigned to you. Press Tab for all open issues.'
          : 'No open issues in this scope.'
      lines.push(
        truncateToWidth(this.theme.fg('warning', `  ${message}`), width, '')
      )
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(MAX_VISIBLE_ISSUES / 2),
          issues.length - MAX_VISIBLE_ISSUES
        )
      )
      const end = Math.min(start + MAX_VISIBLE_ISSUES, issues.length)

      for (let index = start; index < end; index++) {
        const issue = issues[index]
        if (!issue) continue
        const selected = index === this.selectedIndex
        const line = truncateToWidth(
          `${selected ? '→' : ' '} #${issue.number}  ${issue.title}`,
          width,
          ''
        )
        lines.push(
          selected
            ? this.theme.bg('selectedBg', this.theme.fg('accent', line))
            : line
        )
      }

      if (issues.length > MAX_VISIBLE_ISSUES) {
        lines.push(
          truncateToWidth(
            this.theme.fg(
              'dim',
              `  (${this.selectedIndex + 1}/${issues.length})`
            ),
            width,
            ''
          )
        )
      }
    }

    lines.push(
      truncateToWidth(
        this.theme.fg(
          'dim',
          '↑↓ navigate • type to search • tab scope • enter select • esc cancel'
        ),
        width,
        ''
      ),
      border
    )
    return lines
  }
}

async function pickIssue(
  ctx: ExtensionCommandContext,
  assigned: GitHubIssue[],
  all: GitHubIssue[]
): Promise<GitHubIssue | null> {
  return ctx.ui.custom<GitHubIssue | null>(
    (tui, theme, keybindings, done) =>
      new IssuePicker(assigned, all, tui, theme, keybindings, done)
  )
}

function parseIssueNumber(args: string): number | undefined {
  if (!/^\d+$/.test(args)) return undefined
  const issueNumber = Number(args)
  return Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined
}

export default function githubIssuesExtension(pi: ExtensionAPI): void {
  let commandActive = false

  pi.registerCommand('plan-issue', {
    description: 'Plan a GitHub issue. Usage: /plan-issue [issue-number]',
    handler: async (args, ctx) => {
      if (commandActive) {
        ctx.ui.notify('/plan-issue is already active', 'warning')
        return
      }

      const trimmedArgs = args.trim()
      if (trimmedArgs && parseIssueNumber(trimmedArgs) === undefined) {
        ctx.ui.notify('Usage: /plan-issue [positive issue number]', 'error')
        return
      }
      if (!trimmedArgs && ctx.mode !== 'tui') {
        ctx.ui.notify('/plan-issue without a number requires TUI mode', 'error')
        return
      }

      commandActive = true
      try {
        const repository = await resolveRepository(pi, ctx.cwd)
        const explicitIssueNumber = trimmedArgs
          ? parseIssueNumber(trimmedArgs)
          : undefined
        const issue = explicitIssueNumber
          ? await loadIssue(pi, ctx.cwd, repository, explicitIssueNumber)
          : await (async () => {
              const issues = await loadOpenIssues(pi, ctx.cwd, repository)
              return pickIssue(ctx, issues.assigned, issues.all)
            })()

        if (!issue) return

        if (!ctx.isIdle()) {
          ctx.ui.notify(
            'Issue selected; waiting for the current agent turn to finish',
            'info'
          )
        }
        await ctx.waitForIdle()

        pi.setSessionName(`#${issue.number} — ${issue.title}`)
        pi.sendUserMessage(
          `Let’s plan solving issue #${issue.number} from GitHub.`
        )
      } catch (error) {
        const message =
          error instanceof GitHubIssuesError
            ? error.message
            : `GitHub issue planning failed: ${error instanceof Error ? error.message : String(error)}`
        ctx.ui.notify(message, 'error')
      } finally {
        commandActive = false
      }
    }
  })
}
