import {
  getAgentDir,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  hyperlink,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth
} from '@earendil-works/pi-tui'
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const WORK_CONTEXT_RESOURCE = 'work-context'
export const WORK_CONTEXT_CONFIG_FILENAME = 'work-context.json'
export const DEFAULT_POLL_INTERVAL_MS = 60_000
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000
export const BELL = '\x07'

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

export interface LocalChangesSummary {
  changed: number
  untracked: number
  conflicts: number
}

interface PresentationState {
  sessionName?: string
  gitContext?: GitContext
  pullRequest?: PullRequest
  localChanges?: LocalChangesSummary
}

interface HeadWatcher {
  close(): void
}

interface CiObservation {
  root: string
  pullRequestNumber: number
  passed: boolean
}

export interface WorkContextSettings {
  ciPassBell: boolean
}

export interface WorkContextSettingsStore {
  load(): Promise<WorkContextSettings>
  save(settings: WorkContextSettings): Promise<void>
}

export interface WorkContextOutput {
  readonly isTTY?: boolean
  write(chunk: string): unknown
}

export interface WorkContextOptions {
  commandTimeoutMs?: number
  pollIntervalMs?: number
  output?: WorkContextOutput
  settingsStore?: WorkContextSettingsStore
  watchGitHead?: (
    gitDir: string,
    onHeadChange: () => void,
    onError: () => void
  ) => HeadWatcher
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readSettingsFile(
  path: string
): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  const value: unknown = JSON.parse(raw)
  if (!isRecord(value))
    throw new Error('Work-context settings must be an object')
  return value
}

export function createWorkContextSettingsStore(
  path = join(getAgentDir(), WORK_CONTEXT_CONFIG_FILENAME)
): WorkContextSettingsStore {
  return {
    async load() {
      try {
        const settings = await readSettingsFile(path)
        return { ciPassBell: settings.ciPassBell === true }
      } catch {
        return { ciPassBell: false }
      }
    },
    async save(settings) {
      const current = await readSettingsFile(path)
      const next = { ...current, ciPassBell: settings.ciPassBell }
      const directory = dirname(path)
      const temporaryPath = join(
        directory,
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
      )

      await mkdir(directory, { recursive: true })
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600
        })
        await rename(temporaryPath, path)
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {})
      }
    }
  }
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

export function parseLocalChanges(output: string): LocalChangesSummary {
  const changedPaths = new Set<string>()
  const untrackedPaths = new Set<string>()
  const conflictPaths = new Set<string>()
  const records = output.split('\0')

  function pathAfterFields(
    record: string,
    metadataFieldCount: number
  ): string | undefined {
    let start = 2
    for (let index = 0; index < metadataFieldCount; index += 1) {
      const separator = record.indexOf(' ', start)
      if (separator < 0) return undefined
      start = separator + 1
    }
    return record.slice(start) || undefined
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue

    if (record.startsWith('1 ')) {
      const path = pathAfterFields(record, 7)
      if (path) changedPaths.add(path)
      continue
    }

    if (record.startsWith('2 ')) {
      const path = pathAfterFields(record, 8)
      if (path) changedPaths.add(path)
      // Rename/copy records carry the original path as a second NUL field.
      // Always consume it, even when the metadata record was malformed.
      index += 1
      continue
    }

    if (record.startsWith('u ')) {
      const path = pathAfterFields(record, 9)
      if (path) {
        changedPaths.add(path)
        conflictPaths.add(path)
      }
      continue
    }

    if (record.startsWith('? ')) {
      const path = record.slice(2)
      if (path) {
        changedPaths.add(path)
        untrackedPaths.add(path)
      }
    }
  }

  return {
    changed: changedPaths.size,
    untracked: untrackedPaths.size,
    conflicts: conflictPaths.size
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

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function createWorkContext(
  options: WorkContextOptions = {}
): ExtensionFactory {
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const output = options.output ?? process.stdout
  const settingsStore =
    options.settingsStore ?? createWorkContextSettingsStore()
  const createHeadWatcher = options.watchGitHead ?? defaultWatchGitHead

  return (pi: ExtensionAPI) => {
    let generation = 0
    let branchRevision = 0
    let disposed = true
    let state: PresentationState = {}
    let activeContext: ExtensionContext | undefined
    let ciObservation: CiObservation | undefined
    let ciPassBell = false
    let refreshRunning = false
    let refreshQueued = false
    let settingsWrite = Promise.resolve()
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

    // This is the package's only terminal-title presenter. The widget below
    // is deliberately independent and never calls setTitle().
    function presentTitle(ctx: ExtensionContext) {
      const title = composeTitle(state)
      if (title) ctx.ui.setTitle(title)
    }

    function presentWidget(ctx: ExtensionContext) {
      const pullRequest = state.pullRequest
      const localChanges = state.localChanges
      if (!pullRequest && !localChanges?.changed) {
        ctx.ui.setWidget(WORK_CONTEXT_RESOURCE, undefined)
        return
      }

      ctx.ui.setWidget(
        WORK_CONTEXT_RESOURCE,
        (_tui, theme) => ({
          render(width: number) {
            const localVariants: string[] = []
            if (localChanges?.changed) {
              const changed = theme.fg(
                'warning',
                `${localChanges.changed === 1 ? 'Change' : 'Changes'} ${localChanges.changed}`
              )
              const untracked = localChanges.untracked
                ? ` ${theme.fg('dim', '·')} ${theme.fg(
                    'warning',
                    countLabel(localChanges.untracked, 'untracked', 'untracked')
                  )}`
                : ''

              if (localChanges.conflicts) {
                const conflicts = theme.fg(
                  'error',
                  countLabel(localChanges.conflicts, 'conflict')
                )
                localVariants.push(
                  `${conflicts} ${theme.fg('dim', '·')} ${changed}${untracked}`,
                  `${conflicts} ${theme.fg('dim', '·')} ${changed}`,
                  conflicts
                )
              } else {
                localVariants.push(`${changed}${untracked}`, changed)
              }
            }

            let remote: string | undefined
            let remoteCompact: string | undefined
            if (pullRequest) {
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
              remote = `${theme.fg('dim', 'PR')} ${theme.fg(prColor, '●')} ${link}   ${theme.fg('dim', 'CI')} ${theme.fg(check.color, check.text)}`
              remoteCompact = link
            }

            const candidates: string[] = []
            if (remote && localVariants.length > 0) {
              for (const local of localVariants) {
                candidates.push(`${local}   ${remote}`)
              }
              if (localChanges?.conflicts && remoteCompact) {
                candidates.push(
                  `${localVariants.at(-1)}   ${remoteCompact}`,
                  localVariants.at(-1) ?? remote
                )
              } else {
                candidates.push(remote)
                if (remoteCompact) candidates.push(remoteCompact)
                candidates.push(localVariants.at(-1) ?? remote)
              }
            } else if (remote) {
              candidates.push(remote)
              if (remoteCompact) candidates.push(remoteCompact)
            } else {
              candidates.push(...localVariants)
            }

            const availableWidth = Math.max(0, width)
            const line =
              candidates.find(
                (candidate) => visibleWidth(candidate) <= availableWidth
              ) ??
              candidates.at(-1) ??
              ''
            const truncated = truncateToWidth(line, availableWidth, '')
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
      presentWidget(ctx)
    }

    function observeCi(
      ctx: ExtensionContext,
      root: string,
      pullRequest: PullRequest
    ) {
      const passed =
        pullRequest.checks.total > 0 &&
        pullRequest.checks.failed === 0 &&
        pullRequest.checks.pending === 0
      const previous = ciObservation
      const samePullRequest =
        previous?.root === root &&
        previous.pullRequestNumber === pullRequest.number
      const shouldRing = samePullRequest && !previous.passed && passed

      ciObservation = {
        root,
        pullRequestNumber: pullRequest.number,
        passed
      }

      if (
        !shouldRing ||
        !ciPassBell ||
        ctx.mode !== 'tui' ||
        output.isTTY !== true
      ) {
        return
      }

      try {
        output.write(BELL)
      } catch {
        // Notification failures must never interrupt CI refreshes.
      }
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
            // Invalidate branch-bound lookups and notification state
            // immediately, before the debounce expires, so stale results
            // cannot win this race or ring for the new branch.
            branchRevision += 1
            ciObservation = undefined
            if (headChangeTimer) clearTimeout(headChangeTimer)
            headChangeTimer = setTimeout(() => {
              headChangeTimer = undefined
              if (!isCurrent(watcherGeneration) || headWatcher !== watcher) {
                return
              }

              // A checkout can replace both branch-bound GitHub data and the
              // index/worktree summary. Retain only stable session context.
              state = {
                ...state,
                pullRequest: undefined,
                localChanges: undefined
              }
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

    async function findLocalChanges(
      root: string
    ): Promise<LocalChangesSummary | undefined> {
      try {
        const result = await pi.exec(
          'git',
          [
            '--no-optional-locks',
            'status',
            '--porcelain=v2',
            '-z',
            '--untracked-files=all'
          ],
          { cwd: root, timeout: commandTimeoutMs }
        )
        return result.code === 0 ? parseLocalChanges(result.stdout) : undefined
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
          pullRequest: undefined,
          localChanges: undefined
        }
        present(ctx)
        return
      }

      const changedRoot = state.gitContext?.root !== gitContext.root
      if (ciObservation && ciObservation.root !== gitContext.root) {
        ciObservation = undefined
      }
      state = {
        ...state,
        gitContext,
        pullRequest: changedRoot ? undefined : state.pullRequest,
        localChanges: changedRoot ? undefined : state.localChanges
      }
      watchGitHead(ctx, gitContext.gitDir)
      present(ctx)

      await Promise.all([
        findLocalChanges(gitContext.root).then((localChanges) => {
          if (!isCurrent(expectedGeneration, expectedBranchRevision)) return
          state = { ...state, gitContext, localChanges }
          present(ctx)
        }),
        findPullRequest(gitContext.root).then((pullRequest) => {
          if (!isCurrent(expectedGeneration, expectedBranchRevision)) return
          if (pullRequest) observeCi(ctx, gitContext.root, pullRequest)
          state = { ...state, gitContext, pullRequest }
          present(ctx)
        })
      ])
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

    function saveCiPassBell(ctx: ExtensionContext, enabled: boolean) {
      settingsWrite = settingsWrite
        .then(() => settingsStore.save({ ciPassBell: enabled }))
        .catch(() => {
          ctx.ui.notify(
            `CI pass bell is ${enabled ? 'on' : 'off'} for this session, but the setting could not be saved.`,
            'error'
          )
        })
    }

    pi.registerCommand('work-context', {
      description: 'Configure work-context',
      handler: async (_args, ctx) => {
        if (ctx.mode !== 'tui') {
          ctx.ui.notify('/work-context requires TUI mode', 'error')
          return
        }

        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          const items: SettingItem[] = [
            {
              id: 'ci-pass-bell',
              label: 'CI pass bell',
              description:
                'Send a terminal bell when the current PR transitions to fully passed CI.',
              currentValue: ciPassBell ? 'on' : 'off',
              values: ['off', 'on']
            }
          ]
          const container = new Container()
          container.addChild(
            new Text(
              theme.fg('accent', theme.bold('Work Context Settings')),
              1,
              1
            )
          )
          const settingsList = new SettingsList(
            items,
            3,
            getSettingsListTheme(),
            (id, newValue) => {
              if (id !== 'ci-pass-bell') return
              ciPassBell = newValue === 'on'
              saveCiPassBell(ctx, ciPassBell)
            },
            () => done(undefined)
          )
          container.addChild(settingsList)

          return {
            render(width: number) {
              return container.render(width)
            },
            invalidate() {
              container.invalidate()
            },
            handleInput(data: string) {
              settingsList.handleInput(data)
              tui.requestRender()
            }
          }
        })
      }
    })

    pi.on('session_start', async (_event, ctx) => {
      stopSessionResources()
      disposed = false
      generation += 1
      branchRevision += 1
      const expectedGeneration = generation
      activeContext = ctx
      ciObservation = undefined
      ciPassBell = false
      refreshQueued = false
      state = { sessionName: cleanSingleLine(pi.getSessionName()) }

      let loadedCiPassBell = false
      try {
        loadedCiPassBell = (await settingsStore.load()).ciPassBell
      } catch {
        // Missing, unreadable, or malformed settings fail closed.
      }
      if (!isCurrent(expectedGeneration)) return
      ciPassBell = loadedCiPassBell

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

    pi.on('session_shutdown', async (_event, ctx) => {
      disposed = true
      generation += 1
      refreshQueued = false
      activeContext = undefined
      ciObservation = undefined
      stopSessionResources()
      if (ctx.mode === 'tui') {
        ctx.ui.setWidget(WORK_CONTEXT_RESOURCE, undefined)
      }
      await settingsWrite
    })
  }
}

export default createWorkContext()
