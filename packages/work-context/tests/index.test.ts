import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORK_CONTEXT_RESOURCE,
  composeTitle,
  createWorkContext,
  parseGitContext,
  parsePullRequest,
  summarizeChecks,
  type PullRequest
} from '../extensions/work-context/index.js'

type Handler = (
  event: Record<string, unknown>,
  context: ExtensionContext
) => void | Promise<void>

const GIT_OUTPUT = [
  '/projects/worktrees/repo/work-context/repo',
  '/projects/repo/.git',
  '/projects/repo/.git/worktrees/work-context'
].join('\n')

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
  ghOutput?: string
  pollIntervalMs?: number
  mode?: ExtensionContext['mode']
}

function createHarness(options: HarnessOptions = {}) {
  let sessionName = options.sessionName
  let gitOutput = 'gitOutput' in options ? options.gitOutput : GIT_OUTPUT
  let ghOutput = 'ghOutput' in options ? options.ghOutput : pullRequestJson()
  let widgetContent: unknown
  let headChange: (() => void) | undefined
  let watcherError: (() => void) | undefined
  const watcher = { close: vi.fn() }
  const handlers = new Map<string, Handler>()
  const titles: string[] = []

  const exec = vi.fn(async (command: string) => {
    const output = command === 'git' ? gitOutput : ghOutput
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
      setWidget
    }
  } as unknown as ExtensionContext
  const pi = {
    exec,
    getSessionName: vi.fn(() => sessionName),
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
    }
  } as unknown as ExtensionAPI

  createWorkContext({
    pollIntervalMs: options.pollIntervalMs ?? 0,
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
    setGhOutput(output: string | undefined) {
      ghOutput = output
    },
    setGitOutput(output: string | undefined) {
      gitOutput = output
    },
    setSessionName(name: string | undefined) {
      sessionName = name
    },
    setWidget,
    titles,
    watcher,
    watcherError() {
      if (!watcherError) throw new Error('HEAD watcher is not active')
      watcherError()
    }
  }
}

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

describe('work-context extension behavior', () => {
  it('discovers once in the background and drives title and widget from the shared result', async () => {
    const harness = createHarness({
      sessionName: '#6 — Add searchable GitHub issue planning'
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
    expect(harness.exec).toHaveBeenCalledTimes(2)

    await harness.emit('session_info_changed', {
      name: '#6 — Add searchable GitHub issue planning'
    })

    expect(harness.titles.at(-1)).toBe(
      '#6 — Add searchable GitHub issue planning · PR #42'
    )
    expect(harness.exec).toHaveBeenCalledTimes(2)
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

  it('falls back quietly from gh to the stable worktree title', async () => {
    const harness = createHarness({ ghOutput: undefined })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()

    expect(harness.titles.at(-1)).toBe('work-context')
    expect(harness.widgetContent).toBeUndefined()
  })

  it('refreshes externally changed PR and CI state while idle', async () => {
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
    await vi.advanceTimersByTimeAsync(1_000)
    await flushBackground()

    expect(harness.titles.at(-1)).toBe('✓ #42 — Ship work context')
    expect(harness.renderWidget()?.[0]).toContain('CI × 1/2')
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
      'gh',
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
    const harness = createHarness()
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
        stdout: ghCalls === 3 ? '' : pullRequestJson(),
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
  })

  it('invalidates branch-bound PR data on HEAD changes and cleans up', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ pollIntervalMs: 1_000 })
    await harness.emit('session_start', { reason: 'startup' })
    await flushBackground()
    expect(harness.titles.at(-1)).toBe('#42 — Ship work context')

    harness.setGhOutput(undefined)
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
    const harness = createHarness({ ghOutput: undefined })
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
  })
})
