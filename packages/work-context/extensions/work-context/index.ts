import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory
} from '@earendil-works/pi-coding-agent'
import {
  hyperlink,
  truncateToWidth,
  visibleWidth
} from '@earendil-works/pi-tui'
import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'

export const WORK_CONTEXT_RESOURCE = 'work-context'
export const DEFAULT_POLL_INTERVAL_MS = 60_000
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000

const HEAD_CHANGE_DEBOUNCE_MS = 100
const OSC_8_CLOSE = '\u001b]8;;\u001b\\'

export interface GitContext {
  root: string
  gitDir: string
  worktreeName: string
}

export interface CheckSummary {
  total: number
  succeeded: number
  pending: number
  failed: number
}

export interface PullRequest {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  checks: CheckSummary
}

interface PresentationState {
  sessionName?: string
  gitContext?: GitContext
  pullRequest?: PullRequest
}

interface HeadWatcher {
  close(): void
}

export interface WorkContextOptions {
  commandTimeoutMs?: number
  pollIntervalMs?: number
  watchGitHead?: (
    gitDir: string,
    onHeadChange: () => void,
    onError: () => void
  ) => HeadWatcher
}

function cleanSingleLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || undefined
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return undefined
  }

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) {
      return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

export function parseGitContext(output: string): GitContext | undefined {
  const [root, commonDir, gitDir] = output.trim().split(/\r?\n/)
  if (!root || !commonDir || !gitDir) return undefined

  const mainRoot = dirname(commonDir)
  const nestedWorktree =
    root !== mainRoot && basename(root) === basename(mainRoot)

  return {
    root,
    gitDir,
    // Worktree managers commonly use <repo>/<worktree>/<repo>. The middle
    // directory carries the useful workspace identity in that layout.
    worktreeName: nestedWorktree ? basename(dirname(root)) : basename(root)
  }
}

function classifyCheck(value: unknown): 'succeeded' | 'pending' | 'failed' {
  if (!value || typeof value !== 'object') return 'pending'

  const check = value as {
    __typename?: unknown
    status?: unknown
    conclusion?: unknown
    state?: unknown
  }
  const type = typeof check.__typename === 'string' ? check.__typename : ''

  if (type === 'StatusContext' || check.state !== undefined) {
    const state =
      typeof check.state === 'string' ? check.state.toUpperCase() : ''
    if (state === 'SUCCESS') return 'succeeded'
    if (state === 'FAILURE' || state === 'ERROR') return 'failed'
    return 'pending'
  }

  const status =
    typeof check.status === 'string' ? check.status.toUpperCase() : ''
  if (status !== 'COMPLETED') return 'pending'

  const conclusion =
    typeof check.conclusion === 'string' ? check.conclusion.toUpperCase() : ''
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) {
    return 'succeeded'
  }
  if (
    [
      'ACTION_REQUIRED',
      'CANCELLED',
      'FAILURE',
      'STALE',
      'STARTUP_FAILURE',
      'TIMED_OUT'
    ].includes(conclusion)
  ) {
    return 'failed'
  }
  return 'pending'
}

export function summarizeChecks(value: unknown): CheckSummary {
  if (!Array.isArray(value)) {
    return { total: 0, succeeded: 0, pending: 0, failed: 0 }
  }

  const summary: CheckSummary = {
    total: value.length,
    succeeded: 0,
    pending: 0,
    failed: 0
  }
  for (const check of value) {
    summary[classifyCheck(check)] += 1
  }
  return summary
}

export function parsePullRequest(output: string): PullRequest | undefined {
  try {
    const value = JSON.parse(output) as {
      number?: unknown
      title?: unknown
      url?: unknown
      state?: unknown
      isDraft?: unknown
      statusCheckRollup?: unknown
    }
    const title =
      typeof value.title === 'string' ? cleanSingleLine(value.title) : undefined
    const url = safeHttpsUrl(value.url)

    if (
      typeof value.number !== 'number' ||
      !Number.isSafeInteger(value.number) ||
      value.number <= 0 ||
      !title ||
      !url ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(String(value.state)) ||
      typeof value.isDraft !== 'boolean'
    ) {
      return undefined
    }

    return {
      number: value.number,
      title,
      url,
      state: value.state as PullRequest['state'],
      isDraft: value.isDraft,
      checks: summarizeChecks(value.statusCheckRollup)
    }
  } catch {
    return undefined
  }
}

function titleStatePrefix(pullRequest: PullRequest): string {
  if (pullRequest.state === 'MERGED') return '✓ '
  if (pullRequest.state === 'CLOSED') return '× '
  if (pullRequest.isDraft) return '◇ '
  return ''
}

export function composeTitle(state: PresentationState): string | undefined {
  const sessionName = cleanSingleLine(state.sessionName)
  const worktreeName = cleanSingleLine(state.gitContext?.worktreeName)
  const pullRequest = state.pullRequest

  if (pullRequest) {
    const prefix = titleStatePrefix(pullRequest)
    if (sessionName) {
      return `${prefix}${sessionName} · PR #${pullRequest.number}`
    }
    return `${prefix}#${pullRequest.number} — ${pullRequest.title}`
  }

  return sessionName ?? worktreeName
}

function defaultWatchGitHead(
  gitDir: string,
  onHeadChange: () => void,
  onError: () => void
): HeadWatcher {
  const watcher = watch(
    gitDir,
    { persistent: false },
    (_eventType, filename) => {
      if (!filename || filename.toString() === 'HEAD') onHeadChange()
    }
  )
  watcher.on('error', onError)
  return watcher
}

function checkDisplay(checks: CheckSummary): {
  color: 'success' | 'warning' | 'error' | 'dim'
  text: string
} {
  if (checks.total === 0) return { color: 'dim', text: '—' }
  if (checks.failed > 0) {
    return { color: 'error', text: `× ${checks.failed}/${checks.total}` }
  }
  if (checks.pending > 0) {
    return {
      color: 'warning',
      text: `… ${checks.succeeded}/${checks.total}`
    }
  }
  return {
    color: 'success',
    text: `✓ ${checks.succeeded}/${checks.total}`
  }
}

export function createWorkContext(
  options: WorkContextOptions = {}
): ExtensionFactory {
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const createHeadWatcher = options.watchGitHead ?? defaultWatchGitHead

  return (pi: ExtensionAPI) => {
    let generation = 0
    let branchRevision = 0
    let disposed = true
    let state: PresentationState = {}
    let activeContext: ExtensionContext | undefined
    let refreshRunning = false
    let refreshQueued = false
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let headWatcher: HeadWatcher | undefined
    let watchedGitDir: string | undefined
    let headChangeTimer: ReturnType<typeof setTimeout> | undefined

    function isCurrent(
      expectedGeneration: number,
      expectedBranchRevision?: number
    ): boolean {
      return (
        !disposed &&
        generation === expectedGeneration &&
        (expectedBranchRevision === undefined ||
          branchRevision === expectedBranchRevision)
      )
    }

    // This is the package's only terminal-title presenter. The PR widget below
    // is deliberately independent and never calls setTitle().
    function presentTitle(ctx: ExtensionContext) {
      const title = composeTitle(state)
      if (title) ctx.ui.setTitle(title)
    }

    function presentPullRequestWidget(ctx: ExtensionContext) {
      const pullRequest = state.pullRequest
      if (!pullRequest) {
        ctx.ui.setWidget(WORK_CONTEXT_RESOURCE, undefined)
        return
      }

      ctx.ui.setWidget(
        WORK_CONTEXT_RESOURCE,
        (_tui, theme) => ({
          render(width: number) {
            const prColor =
              pullRequest.state === 'OPEN'
                ? pullRequest.isDraft
                  ? 'warning'
                  : 'success'
                : pullRequest.state === 'MERGED'
                  ? 'accent'
                  : 'error'
            const check = checkDisplay(pullRequest.checks)
            const link = hyperlink(
              theme.fg('mdLink', `#${pullRequest.number} ↗`),
              pullRequest.url
            )
            const line = `${theme.fg('dim', 'PR')} ${theme.fg(prColor, '●')} ${link}   ${theme.fg('dim', 'CI')} ${theme.fg(check.color, check.text)}`
            const truncated = truncateToWidth(line, Math.max(0, width), '')
            // truncateToWidth may remove hyperlink()'s zero-width OSC 8
            // terminator. Always close link state explicitly before Pi renders
            // the next terminal content.
            const safeLine = truncated + OSC_8_CLOSE
            return [
              ' '.repeat(Math.max(0, width - visibleWidth(safeLine))) + safeLine
            ]
          },
          invalidate() {}
        }),
        { placement: 'belowEditor' }
      )
    }

    function present(ctx: ExtensionContext) {
      if (disposed || ctx.mode !== 'tui') return
      presentTitle(ctx)
      presentPullRequestWidget(ctx)
    }

    function stopWatchingGitHead() {
      headWatcher?.close()
      headWatcher = undefined
      watchedGitDir = undefined
      if (headChangeTimer) clearTimeout(headChangeTimer)
      headChangeTimer = undefined
    }

    function watchGitHead(ctx: ExtensionContext, gitDir: string) {
      if (headWatcher && watchedGitDir === gitDir) return

      stopWatchingGitHead()
      const watcherGeneration = generation
      let watcher: HeadWatcher
      try {
        watcher = createHeadWatcher(
          gitDir,
          () => {
            if (!isCurrent(watcherGeneration) || headWatcher !== watcher) return
            // Invalidate a branch-bound lookup immediately, before the
            // debounce expires, so its old PR cannot win this race.
            branchRevision += 1
            if (headChangeTimer) clearTimeout(headChangeTimer)
            headChangeTimer = setTimeout(() => {
              headChangeTimer = undefined
              if (!isCurrent(watcherGeneration) || headWatcher !== watcher) {
                return
              }

              // A checkout invalidates branch-bound GitHub data immediately;
              // retain the stable session/worktree context while refreshing.
              state = { ...state, pullRequest: undefined }
              present(ctx)
              requestRefresh(ctx)
            }, HEAD_CHANGE_DEBOUNCE_MS)
            headChangeTimer.unref?.()
          },
          () => {
            if (headWatcher === watcher) stopWatchingGitHead()
          }
        )
      } catch {
        stopWatchingGitHead()
        return
      }

      headWatcher = watcher
      watchedGitDir = gitDir
    }

    async function findGitContext(
      cwd: string
    ): Promise<GitContext | undefined> {
      try {
        const result = await pi.exec(
          'git',
          [
            'rev-parse',
            '--path-format=absolute',
            '--show-toplevel',
            '--git-common-dir',
            '--absolute-git-dir'
          ],
          { cwd, timeout: commandTimeoutMs }
        )
        return result.code === 0 ? parseGitContext(result.stdout) : undefined
      } catch {
        return undefined
      }
    }

    async function findPullRequest(
      root: string
    ): Promise<PullRequest | undefined> {
      try {
        const result = await pi.exec(
          'gh',
          [
            'pr',
            'view',
            '--json',
            'number,title,url,state,isDraft,statusCheckRollup'
          ],
          { cwd: root, timeout: commandTimeoutMs }
        )
        return result.code === 0 ? parsePullRequest(result.stdout) : undefined
      } catch {
        return undefined
      }
    }

    async function refresh(
      ctx: ExtensionContext,
      expectedGeneration: number,
      expectedBranchRevision: number
    ) {
      const gitContext = await findGitContext(ctx.cwd)
      if (!isCurrent(expectedGeneration, expectedBranchRevision)) return

      if (!gitContext) {
        stopWatchingGitHead()
        state = {
          sessionName: state.sessionName,
          gitContext: undefined,
          pullRequest: undefined
        }
        present(ctx)
        return
      }

      const changedRoot = state.gitContext?.root !== gitContext.root
      state = {
        ...state,
        gitContext,
        pullRequest: changedRoot ? undefined : state.pullRequest
      }
      watchGitHead(ctx, gitContext.gitDir)
      present(ctx)

      const pullRequest = await findPullRequest(gitContext.root)
      if (!isCurrent(expectedGeneration, expectedBranchRevision)) return

      state = { ...state, gitContext, pullRequest }
      present(ctx)
    }

    function requestRefresh(ctx: ExtensionContext) {
      if (disposed || ctx.mode !== 'tui') return
      activeContext = ctx
      if (refreshRunning) {
        refreshQueued = true
        return
      }

      refreshRunning = true
      const expectedGeneration = generation
      const expectedBranchRevision = branchRevision
      void refresh(ctx, expectedGeneration, expectedBranchRevision)
        .catch(() => {
          // Work-context discovery is best-effort and must never interrupt Pi.
        })
        .finally(() => {
          refreshRunning = false
          if (!disposed && refreshQueued && activeContext) {
            refreshQueued = false
            requestRefresh(activeContext)
          }
        })
    }

    function stopSessionResources() {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = undefined
      stopWatchingGitHead()
    }

    pi.on('session_start', (_event, ctx) => {
      stopSessionResources()
      disposed = false
      generation += 1
      branchRevision += 1
      activeContext = ctx
      refreshQueued = false
      state = { sessionName: cleanSingleLine(pi.getSessionName()) }

      if (ctx.mode !== 'tui') return
      present(ctx)
      requestRefresh(ctx)

      if (pollIntervalMs > 0) {
        pollTimer = setInterval(() => requestRefresh(ctx), pollIntervalMs)
        pollTimer.unref?.()
      }
    })

    pi.on('session_info_changed', (event, ctx) => {
      if (disposed || ctx.mode !== 'tui') return
      state = { ...state, sessionName: cleanSingleLine(event.name) }
      presentTitle(ctx)
    })

    pi.on('agent_settled', (_event, ctx) => {
      requestRefresh(ctx)
    })

    pi.on('session_shutdown', (_event, ctx) => {
      disposed = true
      generation += 1
      refreshQueued = false
      activeContext = undefined
      stopSessionResources()
      if (ctx.mode === 'tui') {
        ctx.ui.setWidget(WORK_CONTEXT_RESOURCE, undefined)
      }
    })
  }
}

export default createWorkContext()
