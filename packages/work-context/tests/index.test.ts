import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BELL,
  WORK_CONTEXT_RESOURCE,
  composeTitle,
  createWorkContext,
  createWorkContextSettingsStore,
  parseGitContext,
  parseLocalChanges,
  parsePullRequest,
  summarizeChecks,
  type PullRequest,
  type WorkContextSettings,
  type WorkContextSettingsStore
} from '../extensions/work-context/index.js'

type Handler = (
  event: Record<string, unknown>,
  context: ExtensionContext
) => void | Promise<void>

type CommandHandler = (
  args: string,
  context: ExtensionContext
) => void | Promise<void>

const GIT_OUTPUT = [
  '/projects/worktrees/repo/work-context/repo',
  '/projects/repo/.git',
  '/projects/repo/.git/worktrees/work-context'
].join('\n')
const HASH = '0123456789012345678901234567890123456789'

function porcelain(...records: string[]): string {
  return `${records.join('\0')}\0`
}

function ordinary(path: string, status = '.M'): string {
  return `1 ${status} N... 100644 100644 100644 ${HASH} ${HASH} ${path}`
}

function renamed(path: string, score = 'R100'): string {
  return `2 ${score[0]}. N... 100644 100644 100644 ${HASH} ${HASH} ${score} ${path}`
}

function unmerged(path: string): string {
  return `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} ${path}`
}

function pullRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: 'Ship work context',
    url: 'https://github.com/noice-tech/noice-pi/pull/42',
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        status: 'COMPLETED',
        conclusion: 'SUCCESS'
      },
      { __typename: 'StatusContext', state: 'SUCCESS' }
    ],
    ...overrides
  })
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: 'Ship work context',
    url: 'https://github.com/noice-tech/noice-pi/pull/42',
    state: 'OPEN',
    isDraft: false,
    checks: { total: 2, succeeded: 2, pending: 0, failed: 0 },
    ...overrides
  }
}

async function flushBackground() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
  }
}

interface HarnessOptions {
  sessionName?: string
  gitOutput?: string
  statusOutput?: string
  ghOutput?: string
  pollIntervalMs?: number
  mode?: ExtensionContext['mode']
  ciPassBell?: boolean
  isTTY?: boolean
  settingsLoadError?: boolean
  settingsSaveError?: boolean
  outputError?: boolean
  customInputs?: string[]
}

function createHarness(options: HarnessOptions = {}) {
  let sessionName = options.sessionName
  let gitOutput = 'gitOutput' in options ? options.gitOutput : GIT_OUTPUT
  let statusOutput = 'statusOutput' in options ? options.statusOutput : ''
  let ghOutput = 'ghOutput' in options ? options.ghOutput : pullRequestJson()
  let widgetContent: unknown
  let headChange: (() => void) | undefined
  let watcherError: (() => void) | undefined
  let savedSettings: WorkContextSettings = {
    ciPassBell: options.ciPassBell ?? false
  }
  const watcher = { close: vi.fn() }
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, CommandHandler>()
  const titles: string[] = []
  const writes: string[] = []
  const writeAttempts: string[] = []
  const notifications: Array<{ message: string; level: string }> = []
  const customRenders: string[][] = []
  const requestRender = vi.fn()
  const settingsStore: WorkContextSettingsStore = {
    load: vi.fn(async () => {
      if (options.settingsLoadError) throw new Error('load failed')
      return { ...savedSettings }
    }),
    save: vi.fn(async (settings) => {
      if (options.settingsSaveError) throw new Error('save failed')
      savedSettings = { ...settings }
    })
  }

  const exec = vi.fn(async (command: string, args: string[]) => {
    const output =
      command === 'gh'
        ? ghOutput
        : args.includes('status')
          ? statusOutput
          : gitOutput
    return {
      code: output === undefined ? 1 : 0,
      stdout: output ?? '',
      stderr: output === undefined ? 'unavailable' : '',
      killed: false
    }
  })

  const setWidget = vi.fn((_key: string, content: unknown) => {
    widgetContent = content
  })
  const context = {
    cwd: '/projects/worktrees/repo/work-context/repo',
    mode: options.mode ?? 'tui',
    ui: {
      setTitle(title: string) {
        titles.push(title)
      },
      setWidget,
      notify(message: string, level: string) {
        notifications.push({ message, level })
      },
      async custom(factory: (...args: unknown[]) => unknown) {
        let result: unknown
        const component = factory(
          { requestRender },
          {
            bold: (text: string) => text,
            fg: (_color: string, text: string) => text
          },
          {},
          (value: unknown) => {
            result = value
          }
        ) as {
          render(width: number): string[]
          handleInput?(data: string): void
        }
        customRenders.push(component.render(80))
        for (const input of options.customInputs ?? []) {
          component.handleInput?.(input)
        }
        return result
      }
    }
  } as unknown as ExtensionContext
  const pi = {
    exec,
    getSessionName: vi.fn(() => sessionName),
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
    },
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler)
    }
  } as unknown as ExtensionAPI

  createWorkContext({
    pollIntervalMs: options.pollIntervalMs ?? 0,
    settingsStore,
    output: {
      isTTY: 'isTTY' in options ? options.isTTY : true,
      write(chunk: string) {
        writeAttempts.push(chunk)
        if (options.outputError) throw new Error('output failed')
        writes.push(chunk)
      }
    },
    watchGitHead(_gitDir, onHeadChange, onError) {
      headChange = onHeadChange
      watcherError = onError
      return watcher
    }
  })(pi)

  async function emit(event: string, fields: Record<string, unknown> = {}) {
    const handler = handlers.get(event)
    if (!handler) throw new Error(`No handler registered for ${event}`)
    await handler({ type: event, ...fields }, context)
  }

  return {
    context,
    emit,
    exec,
    get widgetContent() {
      return widgetContent
    },
    headChange() {
      if (!headChange) throw new Error('HEAD watcher is not active')
      headChange()
    },
    renderWidget(width = 120) {
      if (typeof widgetContent !== 'function') return undefined
      const component = widgetContent(
        {},
        { fg: (_color: string, text: string) => text }
      ) as { render(width: number): string[] }
      return component.render(width)
    },
    async runCommand(name = 'work-context') {
      const command = commands.get(name)
      if (!command) throw new Error(`No command registered for ${name}`)
      await command('', context)
    },
    setGhOutput(output: string | undefined) {
      ghOutput = output
    },
    setGitOutput(output: string | undefined) {
      gitOutput = output
    },
    setStatusOutput(output: string | undefined) {
      statusOutput = output
    },
    setSessionName(name: string | undefined) {
      sessionName = name
    },
    customRenders,
    notifications,
    requestRender,
    settingsStore,
    get savedSettings() {
      return savedSettings
    },
    setWidget,
    titles,
    watcher,
    writeAttempts,
    writes,
    watcherError() {
      if (!watcherError) throw new Error('HEAD watcher is not active')
      watcherError()
    }
  }
}

beforeAll(() => {
  initTheme(undefined, false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('context parsing and title composition', () => {
  it('preserves nested and ordinary worktree names', () => {
    expect(parseGitContext(GIT_OUTPUT)).toEqual({
      root: '/projects/worktrees/repo/work-context/repo',
      gitDir: '/projects/repo/.git/worktrees/work-context',
      worktreeName: 'work-context'
    })
    expect(
      parseGitContext(
        ['/projects/repo', '/projects/repo/.git', '/projects/repo/.git'].join(
          '\r\n'
        )
      )?.worktreeName
    ).toBe('repo')
  })

  it('uses session, pull request, and worktree precedence with compact state markers', () => {
    const gitContext = parseGitContext(GIT_OUTPUT)
    const sessionName = '#6 — Add searchable GitHub issue planning'

    expect(composeTitle({ sessionName, gitContext })).toBe(sessionName)
    expect(
      composeTitle({ sessionName, gitContext, pullRequest: pullRequest() })
    ).toBe(`${sessionName} · PR #42`)
    expect(
      composeTitle({
        sessionName,
        gitContext,
        pullRequest: pullRequest({ state: 'MERGED' })
      })
    ).toBe(`✓ ${sessionName} · PR #42`)
    expect(
      composeTitle({
        sessionName,
        gitContext,
        pullRequest: pullRequest({ isDraft: true })
      })
    ).toBe(`◇ ${sessionName} · PR #42`)
    expect(
      composeTitle({
        gitContext,
        pullRequest: pullRequest({ state: 'CLOSED' })
      })
    ).toBe('× #42 — Ship work context')
    expect(composeTitle({ gitContext, pullRequest: pullRequest() })).toBe(
      '#42 — Ship work context'
    )
    expect(composeTitle({ gitContext })).toBe('work-context')
  })

  it('sanitizes terminal control characters from title inputs', () => {
    expect(
      composeTitle({ sessionName: 'Task\u001b]0;spoof\u0007\nnext' })
    ).toBe('Task ]0;spoof next')
    expect(
      parsePullRequest(
        pullRequestJson({
          url: 'https://github.com/noice-tech/noice-pi/pull/42\u001b]8;;bad'
        })
      )
    ).toBeUndefined()
  })
})

describe('local Git status parsing', () => {
  it('counts unique index, working-tree, and untracked paths while ignoring ignored files', () => {
    expect(
      parseLocalChanges(
        porcelain(
          ordinary('staged.ts', 'M.'),
          ordinary('working tree.ts'),
          ordinary('both.ts', 'MM'),
          ordinary('both.ts', 'MM'),
          '? new file.ts',
          '? new file.ts',
          '! ignored.log'
        )
      )
    ).toEqual({ changed: 4, untracked: 1, conflicts: 0 })
  })

  it('counts renames and copies once and consumes their second NUL path', () => {
    expect(
      parseLocalChanges(
        porcelain(
          renamed('renamed file.ts'),
          '? old name that resembles a record',
          renamed('copied.ts', 'C075'),
          'source.ts'
        )
      )
    ).toEqual({ changed: 2, untracked: 0, conflicts: 0 })
  })

  it('counts unmerged entries as both changed files and conflicts', () => {
    expect(
      parseLocalChanges(
        porcelain(
          unmerged('conflicted file.ts'),
          unmerged('second.ts'),
          '? new.ts'
        )
      )
    ).toEqual({ changed: 3, untracked: 1, conflicts: 2 })
    expect(parseLocalChanges('')).toEqual({
      changed: 0,
      untracked: 0,
      conflicts: 0
    })
  })
})

describe('GitHub check aggregation', () => {
  it('aggregates check runs and status contexts', () => {
    expect(
      summarizeChecks([
        {
          __typename: 'CheckRun',
          status: 'COMPLETED',
          conclusion: 'SUCCESS'
        },
        {
          __typename: 'CheckRun',
          status: 'COMPLETED',
          conclusion: 'SKIPPED'
        },
        {
          __typename: 'CheckRun',
          status: 'IN_PROGRESS',
          conclusion: null
        },
        { __typename: 'StatusContext', state: 'FAILURE' }
      ])
    ).toEqual({ total: 4, succeeded: 2, pending: 1, failed: 1 })
  })

  it('keeps valid PR metadata when check details are absent', () => {
    expect(
      parsePullRequest(pullRequestJson({ statusCheckRollup: null }))
    ).toEqual(
      pullRequest({ checks: { total: 0, succeeded: 0, pending: 0, failed: 0 } })
    )
    expect(parsePullRequest('{broken')).toBeUndefined()
  })
})

describe('work-context settings persistence', () => {
  it('defaults missing settings to off and preserves unknown fields on save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-work-context-'))
    const path = join(directory, 'work-context.json')
    try {
      const store = createWorkContextSettingsStore(path)
      await expect(store.load()).resolves.toEqual({ ciPassBell: false })

      await writeFile(
        path,
        JSON.stringify({ ciPassBell: true, futureSetting: 'keep-me' })
      )
      await expect(store.load()).resolves.toEqual({ ciPassBell: true })

      await store.save({ ciPassBell: false })
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        ciPassBell: false,
        futureSetting: 'keep-me'
      })
      expect(await readFile(path, 'utf8')).toMatch(/\n$/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on malformed settings and refuses to overwrite them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-work-context-'))
    const path = join(directory, 'work-context.json')
    try {
      await writeFile(path, '{broken')
      const store = createWorkContextSettingsStore(path)

      await expect(store.load()).resolves.toEqual({ ciPassBell: false })
      await expect(store.save({ ciPassBell: true })).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('{broken')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('work-context extension behavior', () => {
  it('discovers once in the background and drives title and widget from the shared result', async () => {
    const harness = createHarness({
      sessionName: '#6 — Add searchable GitHub issue planning',
      statusOutput: porcelain(
        ordinary('tracked.ts'),
        '? first new.ts',
        '? second new.ts'
      )
    })

    await harness.emit('session_start', { reason: 'startup' })
    expect(harness.titles[0]).toBe('#6 — Add searchable GitHub issue planning')

    await flushBackground()

    expect(harness.exec).toHaveBeenNthCalledWith(
      1,
      'git',
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
        '--absolute-git-dir'
      ],
      {
        cwd: '/projects/worktrees/repo/work-context/repo',
        timeout: 5_000
      }
    )
    expect(harness.exec).toHaveBeenNthCalledWith(
      2,
      'git',
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all'
      ],
      {
        cwd: '/projects/worktrees/repo/work-context/repo',
        timeout: 5_000
      }
    )
    expect(harness.exec).toHaveBeenNthCalledWith(
      3,
      'gh',
      [
        'pr',
        'view',
        '--json',
        'number,title,url,state,isDraft,statusCheckRollup'
      ],
      {
        cwd: '/projects/worktrees/repo/work-context/repo',
        timeout: 5_000
      }
    )
    expect(harness.titles.at(-1)).toBe(
      '#6 — Add searchable GitHub issue planning · PR #42'
    )
    expect(harness.setWidget).toHaveBeenLastCalledWith(
      WORK_CONTEXT_RESOURCE,
      expect.any(Function),
      { placement: 'belowEditor' }
    )
    const [line] = harness.renderWidget() ?? []
    expect(line).toContain('Changes 3 · 2 untracked')
    expect(line).toContain('PR ●')
    expect(line).toContain('#42 ↗')
    expect(line).toContain('CI ✓ 2/2')
    expect(line).toContain(
      '\u001b]8;;https://github.com/noice-tech/noice-pi/pull/42'
    )

    for (const width of [0, 1, 6, 10, 20]) {
      const [narrowLine] = harness.renderWidget(width) ?? []
      expect(visibleWidth(narrowLine ?? '')).toBeLessThanOrEqual(width)
      expect(narrowLine).toMatch(/\u001b\]8;;\u001b\\$/)
    }
  })

  it('reacts to session renames without repeating GitHub discovery', async () => {
    const harness = createHarness()
    await harness.emit('session_start', { reason: 'resume' })
    await flushBackground()
    expect(harness.exec).toHaveBeenCalledTimes(3)

    await harness.emit('session_info_changed', {
      name: '#6 — Add searchable GitHub issue planning'
    })

    expect(harness.titles.at(-1)).toBe(
      '#6 — Add searchable GitHub issue planning · PR #42'
    )
    expect(harness.exec).toHaveBeenCalledTimes(3)
  })

  it.each(['rpc', 'json', 'print'] satisfies ExtensionContext['mode'][])(
    'does not start terminal discovery or presentation in %s mode',
    async (mode) => {
      const harness = createHarness({ mode, pollIntervalMs: 1 })
      await harness.emit('session_start', { reason: 'startup' })
      await harness.emit('agent_settled')
      await flushBackground()

      expect(harness.exec).not.toHaveBeenCalled()
      expect(harness.titles).toEqual([])
      expect(harness.setWidget).not.toHaveBeenCalled()
    }
  )

  it('configures the CI pass bell in a TUI settings list and applies it immediately', async () => {
    const harness = createHarness({
      ghOutput: pullRequestJson({
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }
        ]
      }),
      customInputs: [' ', '\u001b']
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    await harness.runCommand()
    await flushBackground()

    expect(harness.customRenders.flat().join('\n')).toContain(
      'Work Context Settings'
    )
    expect(harness.customRenders.flat().join('\n')).toContain('CI pass bell')
    expect(harness.settingsStore.save).toHaveBeenCalledWith({
      ciPassBell: true
    })
    expect(harness.savedSettings).toEqual({ ciPassBell: true })
    expect(harness.requestRender).toHaveBeenCalled()

    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL])
  })

  it('keeps a changed setting active for the session when persistence fails', async () => {
    const harness = createHarness({
      ghOutput: pullRequestJson({
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }
        ]
      }),
      customInputs: [' ', '\u001b'],
      settingsSaveError: true
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    await harness.runCommand()
    await flushBackground()

    expect(harness.notifications).toContainEqual({
      message:
        'CI pass bell is on for this session, but the setting could not be saved.',
      level: 'error'
    })
    expect(harness.savedSettings).toEqual({ ciPassBell: false })

    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL])
  })

  it.each(['rpc', 'json', 'print'] satisfies ExtensionContext['mode'][])(
    'keeps /work-context TUI-only in %s mode',
    async (mode) => {
      const harness = createHarness({ mode })
      await harness.emit('session_start', { reason: 'startup' })
      await harness.runCommand()

      expect(harness.customRenders).toEqual([])
      expect(harness.notifications).toEqual([
        { message: '/work-context requires TUI mode', level: 'error' }
      ])
    }
  )

  it('rings only on observed transitions into fully passed CI', async () => {
    const harness = createHarness({ ciPassBell: true })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(harness.writes).toEqual([])

    harness.setGhOutput(
      pullRequestJson({
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }
        ]
      })
    )
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([])

    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL])
    expect(Buffer.from(harness.writes[0] ?? '')).toEqual(Buffer.from([0x07]))

    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL])

    harness.setGhOutput(
      pullRequestJson({
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            status: 'COMPLETED',
            conclusion: 'FAILURE'
          }
        ]
      })
    )
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL, BELL])

    harness.setGhOutput(pullRequestJson({ statusCheckRollup: null }))
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL, BELL, BELL])
  })

  it('does not ring when the setting is disabled or cannot be loaded', async () => {
    for (const options of [
      {},
      { settingsLoadError: true, ciPassBell: true }
    ] satisfies HarnessOptions[]) {
      const harness = createHarness({
        ...options,
        ghOutput: pullRequestJson({ statusCheckRollup: null })
      })
      await harness.emit('session_start', { reason: 'startup' })
      await flushBackground()
      harness.setGhOutput(pullRequestJson())
      await harness.emit('agent_settled')
      await flushBackground()
      expect(harness.writes).toEqual([])
    }
  })

  it('preserves the last valid observation across transient GitHub failures', async () => {
    const harness = createHarness({
      ciPassBell: true,
      ghOutput: pullRequestJson({ statusCheckRollup: null })
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    harness.setGhOutput(undefined)
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()

    expect(harness.writes).toEqual([BELL])
  })

  it('preserves the last valid observation across transient Git failures', async () => {
    const harness = createHarness({
      ciPassBell: true,
      ghOutput: pullRequestJson({ statusCheckRollup: null })
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    harness.setGitOutput(undefined)
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGitOutput(GIT_OUTPUT)
    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()

    expect(harness.writes).toEqual([BELL])
  })

  it('uses new baselines after PR, root, HEAD, and session changes', async () => {
    vi.useFakeTimers()
    const pending = pullRequestJson({ statusCheckRollup: null })
    const harness = createHarness({ ciPassBell: true, ghOutput: pending })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    harness.setGhOutput(pullRequestJson({ number: 43 }))
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([])

    harness.setGhOutput(
      pullRequestJson({ number: 43, statusCheckRollup: null })
    )
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGhOutput(pullRequestJson({ number: 43 }))
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL])

    harness.setGitOutput(
      ['/other/repo', '/other/repo/.git', '/other/repo/.git'].join('\n')
    )
    harness.setGhOutput(pullRequestJson({ number: 44 }))
    await harness.emit('agent_settled')
    await flushBackground()
    expect(harness.writes).toEqual([BELL])

    harness.setGhOutput(
      pullRequestJson({ number: 44, statusCheckRollup: null })
    )
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGhOutput(pullRequestJson({ number: 44 }))
    harness.headChange()
    await vi.advanceTimersByTimeAsync(100)
    await flushBackground()
    expect(harness.writes).toEqual([BELL])

    harness.setGhOutput(
      pullRequestJson({ number: 44, statusCheckRollup: null })
    )
    await harness.emit('agent_settled')
    await flushBackground()
    harness.setGhOutput(pullRequestJson({ number: 44 }))
    await harness.emit('session_start', { reason: 'resume' })
    await flushBackground()
    expect(harness.writes).toEqual([BELL])
  })

  it.each([false, undefined])(
    'does not write a bell when output isTTY is %s',
    async (isTTY) => {
      const harness = createHarness({
        ciPassBell: true,
        isTTY,
        ghOutput: pullRequestJson({ statusCheckRollup: null })
      })
      await harness.emit('session_start', { reason: 'startup' })
      await flushBackground()
      harness.setGhOutput(pullRequestJson())
      await harness.emit('agent_settled')
      await flushBackground()

      expect(harness.writeAttempts).toEqual([])
    }
  )

  it('swallows output failures without retrying the passed observation', async () => {
    const harness = createHarness({
      ciPassBell: true,
      outputError: true,
      ghOutput: pullRequestJson({ statusCheckRollup: null })
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    harness.setGhOutput(pullRequestJson())
    await harness.emit('agent_settled')
    await flushBackground()
    await harness.emit('agent_settled')
    await flushBackground()

    expect(harness.writeAttempts).toEqual([BELL])
    expect(harness.writes).toEqual([])
  })

  it('hides the clean state and falls back quietly without GitHub context', async () => {
    const harness = createHarness({ ghOutput: undefined })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    expect(harness.titles.at(-1)).toBe('work-context')
    expect(harness.widgetContent).toBeUndefined()
  })

  it('uses singular wording for one changed and untracked file', async () => {
    const harness = createHarness({
      ghOutput: undefined,
      statusOutput: porcelain('? only new file.ts')
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    expect(harness.renderWidget()?.[0]).toContain('Change 1 · 1 untracked')
  })

  it('shows local-only counts with singular wording and conflict-first degradation', async () => {
    const harness = createHarness({
      ghOutput: undefined,
      statusOutput: porcelain(unmerged('conflict.ts'), '? new file.ts')
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    expect(harness.renderWidget()?.[0]).toContain(
      '1 conflict · Changes 2 · 1 untracked'
    )
    const [narrowLine] = harness.renderWidget(10) ?? []
    expect(narrowLine).toContain('1 conflict')
    expect(visibleWidth(narrowLine ?? '')).toBeLessThanOrEqual(10)
  })

  it('degrades non-conflict details before truncating the changed-file count', async () => {
    const harness = createHarness({
      ghOutput: undefined,
      statusOutput: porcelain(
        ordinary('one.ts'),
        ordinary('two.ts'),
        ordinary('three.ts'),
        ordinary('four.ts'),
        ordinary('five.ts'),
        '? six.ts',
        '? seven.ts'
      )
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    expect(harness.renderWidget()?.[0]).toContain('Changes 7 · 2 untracked')
    expect(harness.renderWidget(9)?.[0]).toContain('Changes 7')
    expect(visibleWidth(harness.renderWidget(9)?.[0] ?? '')).toBe(9)
  })

  it('keeps PR and CI context when local status discovery fails', async () => {
    const harness = createHarness({ statusOutput: undefined })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    const [line] = harness.renderWidget() ?? []
    expect(line).toContain('PR ●')
    expect(line).toContain('CI ✓ 2/2')
    expect(line).not.toContain('Changes')
    expect(harness.titles.at(-1)).toBe('#42 — Ship work context')
  })

  it('refreshes externally changed PR, CI, and local state while idle', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ pollIntervalMs: 1_000 })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(harness.titles.at(-1)).toBe('#42 — Ship work context')

    harness.setGhOutput(
      pullRequestJson({
        state: 'MERGED',
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            status: 'COMPLETED',
            conclusion: 'FAILURE'
          },
          {
            __typename: 'CheckRun',
            status: 'COMPLETED',
            conclusion: 'SUCCESS'
          }
        ]
      })
    )
    harness.setStatusOutput(
      porcelain(ordinary('tracked.ts'), '? first.ts', '? second.ts')
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await flushBackground()

    expect(harness.titles.at(-1)).toBe('✓ #42 — Ship work context')
    expect(harness.renderWidget()?.[0]).toContain('CI × 1/2')
    expect(harness.renderWidget()?.[0]).toContain('Changes 3 · 2 untracked')
  })

  it('presents local status without waiting for GitHub discovery', async () => {
    let resolveGh: ((value: string) => void) | undefined
    const ghResult = new Promise<string>((resolve) => {
      resolveGh = resolve
    })
    const harness = createHarness()
    harness.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh') {
        return {
          code: 0,
          stdout: await ghResult,
          stderr: '',
          killed: false
        }
      }
      return {
        code: 0,
        stdout: args.includes('status')
          ? porcelain(ordinary('changed.ts'))
          : GIT_OUTPUT,
        stderr: '',
        killed: false
      }
    })

    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    expect(harness.renderWidget()?.[0]).toContain('Change 1')
    expect(harness.titles.at(-1)).toBe('work-context')

    await harness.emit('session_shutdown', { reason: 'quit' })
    resolveGh?.(pullRequestJson())
    await flushBackground()
  })

  it('coalesces poll ticks while discovery is still running', async () => {
    vi.useFakeTimers()
    let finishFirstGh: (() => void) | undefined
    const firstGh = new Promise<void>((resolve) => {
      finishFirstGh = resolve
    })
    let ghCalls = 0
    const harness = createHarness({ pollIntervalMs: 1_000 })
    harness.exec.mockImplementation(async (command: string) => {
      if (command === 'git') {
        return {
          code: 0,
          stdout: GIT_OUTPUT,
          stderr: '',
          killed: false
        }
      }

      ghCalls += 1
      if (ghCalls === 1) await firstGh
      return {
        code: 0,
        stdout: pullRequestJson(),
        stderr: '',
        killed: false
      }
    })

    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(ghCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(ghCalls).toBe(1)

    finishFirstGh?.()
    await flushBackground()
    expect(ghCalls).toBe(2)
    expect(harness.exec.mock.calls.map(([command]) => command)).toEqual([
      'git',
      'git',
      'gh',
      'git',
      'git',
      'gh'
    ])

    await harness.emit('session_shutdown', { reason: 'quit' })
  })

  it('rejects an in-flight PR result after HEAD changes', async () => {
    vi.useFakeTimers()
    let finishStaleGh: (() => void) | undefined
    const staleGh = new Promise<void>((resolve) => {
      finishStaleGh = resolve
    })
    let ghCalls = 0
    const harness = createHarness({ ciPassBell: true })
    harness.exec.mockImplementation(async (command: string) => {
      if (command === 'git') {
        return {
          code: 0,
          stdout: GIT_OUTPUT,
          stderr: '',
          killed: false
        }
      }

      ghCalls += 1
      if (ghCalls === 2) {
        await staleGh
        return {
          code: 0,
          stdout: pullRequestJson({ state: 'MERGED' }),
          stderr: '',
          killed: false
        }
      }
      return {
        code: ghCalls === 3 ? 1 : 0,
        stdout:
          ghCalls === 3 ? '' : pullRequestJson({ statusCheckRollup: null }),
        stderr: '',
        killed: false
      }
    })

    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(harness.titles.at(-1)).toBe('#42 — Ship work context')

    await harness.emit('agent_settled')
    await flushBackground()
    expect(ghCalls).toBe(2)
    harness.headChange()
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.titles.at(-1)).toBe('work-context')

    finishStaleGh?.()
    await flushBackground()

    expect(ghCalls).toBe(3)
    expect(harness.titles).not.toContain('✓ #42 — Ship work context')
    expect(harness.titles.at(-1)).toBe('work-context')
    expect(harness.writes).toEqual([])
  })

  it('rejects an in-flight local status result after HEAD changes', async () => {
    vi.useFakeTimers()
    let finishStaleStatus: (() => void) | undefined
    const staleStatus = new Promise<void>((resolve) => {
      finishStaleStatus = resolve
    })
    let statusCalls = 0
    const harness = createHarness({ ghOutput: undefined })
    harness.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh') {
        return {
          code: 1,
          stdout: '',
          stderr: 'unavailable',
          killed: false
        }
      }
      if (!args.includes('status')) {
        return {
          code: 0,
          stdout: GIT_OUTPUT,
          stderr: '',
          killed: false
        }
      }

      statusCalls += 1
      if (statusCalls === 2) {
        await staleStatus
        return {
          code: 0,
          stdout: porcelain(ordinary('stale.ts')),
          stderr: '',
          killed: false
        }
      }
      return { code: 0, stdout: '', stderr: '', killed: false }
    })

    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    await harness.emit('agent_settled')
    await flushBackground()
    expect(statusCalls).toBe(2)

    harness.headChange()
    await vi.advanceTimersByTimeAsync(100)
    finishStaleStatus?.()
    await flushBackground()

    expect(statusCalls).toBe(3)
    expect(harness.widgetContent).toBeUndefined()
  })

  it('invalidates branch-bound PR and local data on HEAD changes and cleans up', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      pollIntervalMs: 1_000,
      statusOutput: porcelain(ordinary('changed.ts'))
    })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(harness.titles.at(-1)).toBe('#42 — Ship work context')
    expect(harness.renderWidget()?.[0]).toContain('Change 1')

    harness.setGhOutput(undefined)
    harness.setStatusOutput('')
    harness.headChange()
    await vi.advanceTimersByTimeAsync(100)
    await flushBackground()

    expect(harness.titles).toContain('work-context')
    expect(harness.titles.at(-1)).toBe('work-context')
    expect(harness.widgetContent).toBeUndefined()

    const callsBeforeShutdown = harness.exec.mock.calls.length
    await harness.emit('session_shutdown', { reason: 'quit' })
    expect(harness.watcher.close).toHaveBeenCalledOnce()
    expect(harness.setWidget).toHaveBeenLastCalledWith(
      WORK_CONTEXT_RESOURCE,
      undefined
    )

    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.exec).toHaveBeenCalledTimes(callsBeforeShutdown)
  })

  it('ignores late GitHub results after shutdown', async () => {
    let resolveGh: ((value: string) => void) | undefined
    const ghResult = new Promise<string>((resolve) => {
      resolveGh = resolve
    })
    const harness = createHarness({
      ghOutput: undefined,
      ciPassBell: true
    })
    harness.exec.mockImplementation(async (command: string) => {
      if (command === 'git') {
        return {
          code: 0,
          stdout: GIT_OUTPUT,
          stderr: '',
          killed: false
        }
      }
      return {
        code: 0,
        stdout: await ghResult,
        stderr: '',
        killed: false
      }
    })

    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(harness.titles.at(-1)).toBe('work-context')

    await harness.emit('session_shutdown', { reason: 'quit' })
    resolveGh?.(pullRequestJson({ state: 'MERGED' }))
    await flushBackground()

    expect(harness.titles.at(-1)).toBe('work-context')
    expect(harness.widgetContent).toBeUndefined()
    expect(harness.writes).toEqual([])
  })
})
