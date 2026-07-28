import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry
} from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import {
  createCutover,
  latestAssistantText,
  writeTemporaryPlan
} from '../extensions/cutover/index.js'

type CommandHandler = (
  args: string,
  context: ExtensionCommandContext
) => void | Promise<void>
type CompactOptions = NonNullable<
  Parameters<ExtensionCommandContext['compact']>[0]
>

interface HarnessOptions {
  branch?: SessionEntry[]
  branchAfterWait?: SessionEntry[]
  idle?: boolean
  writePlan?: (content: string) => Promise<string>
  waitForIdle?: () => Promise<void>
  sendError?: Error
}

function messageEntry(
  role: 'assistant' | 'user',
  content: unknown,
  id: string = role
): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role,
      content,
      timestamp: 0
    }
  } as unknown as SessionEntry
}

function assistantEntry(content: unknown[], id?: string): SessionEntry {
  return messageEntry('assistant', content, id)
}

function createHarness(options: HarnessOptions = {}) {
  let branch = options.branch ?? [
    assistantEntry([{ type: 'text', text: '# Default plan' }])
  ]
  let idle = options.idle ?? true
  let compactOptions: CompactOptions | undefined
  const commands = new Map<
    string,
    { description?: string; handler: CommandHandler }
  >()
  const notifications: Array<{
    message: string
    type: 'info' | 'warning' | 'error' | undefined
  }> = []
  const sentMessages: string[] = []
  const sequence: string[] = []
  const writtenPlans: string[] = []
  const writePlan =
    options.writePlan ??
    (async (content: string) => {
      sequence.push('write')
      writtenPlans.push(content)
      return '/tmp/pi-cutover-test/plan.md'
    })

  const pi = {
    registerCommand(
      name: string,
      command: { description?: string; handler: CommandHandler }
    ) {
      commands.set(name, command)
    },
    sendUserMessage(content: string) {
      if (options.sendError) throw options.sendError
      sentMessages.push(content)
    }
  } as unknown as ExtensionAPI

  const context = {
    compact(value: CompactOptions) {
      sequence.push('compact')
      compactOptions = value
    },
    isIdle() {
      return idle
    },
    sessionManager: {
      getBranch() {
        sequence.push('branch')
        return branch
      },
      getEntries() {
        throw new Error('Cutover must only inspect the active branch')
      }
    },
    ui: {
      notify(message: string, type?: 'info' | 'warning' | 'error') {
        notifications.push({ message, type })
      }
    },
    async waitForIdle() {
      sequence.push('wait')
      await options.waitForIdle?.()
      branch = options.branchAfterWait ?? branch
      idle = true
    }
  } as unknown as ExtensionCommandContext

  createCutover({ writePlan })(pi)

  return {
    commands,
    context,
    notifications,
    sentMessages,
    sequence,
    writtenPlans,
    get compactOptions() {
      return compactOptions
    },
    async run(args = '') {
      const command = commands.get('cutover')
      if (!command) throw new Error('/cutover was not registered')
      await command.handler(args, context)
    },
    setBranch(value: SessionEntry[]) {
      branch = value
    }
  }
}

describe('assistant plan selection', () => {
  it('uses the latest assistant response on the active branch', () => {
    const branch = [
      assistantEntry([{ type: 'text', text: 'old plan' }], 'old'),
      messageEntry('user', 'revise it'),
      assistantEntry(
        [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: '  # Final plan' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'read',
            arguments: {}
          },
          { type: 'text', text: 'Step one.  ' }
        ],
        'latest'
      )
    ]

    expect(latestAssistantText(branch)).toBe('# Final plan\nStep one.')
  })

  it('does not fall back when the latest assistant response has no text', () => {
    const branch = [
      assistantEntry([{ type: 'text', text: 'older plan' }], 'old'),
      assistantEntry(
        [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'read',
            arguments: {}
          }
        ],
        'latest'
      )
    ]

    expect(() => latestAssistantText(branch)).toThrow(
      'The latest assistant response has no text to save.'
    )
  })

  it('reports a branch with no assistant response', () => {
    expect(() =>
      latestAssistantText([messageEntry('user', 'make a plan')])
    ).toThrow('The current session branch has no assistant response.')
  })
})

describe('temporary plan writer', () => {
  it('writes normalized Markdown to unique OS temporary directories', async () => {
    const paths: string[] = []

    try {
      paths.push(await writeTemporaryPlan('\n\n# Plan\n\nStep one.  \n'))
      paths.push(await writeTemporaryPlan('# Another plan'))

      expect(paths[0]).not.toBe(paths[1])
      for (const path of paths) {
        expect(path).toBe(join(dirname(path), 'plan.md'))
        expect(dirname(path)).toMatch(
          new RegExp(`^${escapeRegExp(join(tmpdir(), 'pi-cutover-'))}`)
        )
      }
      expect(await readFile(paths[0]!, 'utf8')).toBe('# Plan\n\nStep one.\n')
      expect(await readFile(paths[1]!, 'utf8')).toBe('# Another plan\n')
    } finally {
      await Promise.all(
        paths.map((path) => rm(dirname(path), { recursive: true, force: true }))
      )
    }
  })
})

describe('/cutover', () => {
  it('registers only the cutover command with a useful description', () => {
    const harness = createHarness()

    expect([...harness.commands]).toEqual([
      [
        'cutover',
        expect.objectContaining({
          description: 'Save the latest plan, compact, and start implementation'
        })
      ]
    ])
  })

  it('waits, reads the active branch, writes, and then compacts', async () => {
    const harness = createHarness({
      branch: [assistantEntry([{ type: 'text', text: '# Plan' }])]
    })

    await harness.run()

    expect(harness.sequence).toEqual(['wait', 'branch', 'write', 'compact'])
    expect(harness.writtenPlans).toEqual(['# Plan'])
    expect(harness.sentMessages).toEqual([])
    expect(harness.notifications).toContainEqual({
      message:
        'Saved the plan to /tmp/pi-cutover-test/plan.md. Compacting the session…',
      type: 'info'
    })
  })

  it('snapshots the completed response only after a busy agent becomes idle', async () => {
    const harness = createHarness({
      idle: false,
      branch: [assistantEntry([{ type: 'text', text: 'partial' }])],
      branchAfterWait: [
        assistantEntry([{ type: 'text', text: '# Completed plan' }])
      ]
    })

    await harness.run()

    expect(harness.writtenPlans).toEqual(['# Completed plan'])
    expect(harness.notifications[0]).toEqual({
      message: 'Waiting for the current turn before cutting over…',
      type: 'info'
    })
  })

  it('starts implementation only after successful compaction', async () => {
    const harness = createHarness()

    await harness.run()
    expect(harness.sentMessages).toEqual([])

    harness.compactOptions?.onComplete?.({} as never)

    expect(harness.sentMessages).toEqual([
      'Implement the plan from /tmp/pi-cutover-test/plan.md'
    ])
  })

  it('rejects another cutover while the first is waiting for idle', async () => {
    let finishWaiting!: () => void
    const waiting = new Promise<void>((resolve) => {
      finishWaiting = resolve
    })
    const harness = createHarness({ idle: false, waitForIdle: () => waiting })

    const firstRun = harness.run()
    await harness.run()

    expect(harness.notifications.at(-1)).toEqual({
      message: 'A cutover is already in progress.',
      type: 'warning'
    })
    expect(harness.compactOptions).toBeUndefined()

    finishWaiting()
    await firstRun
    expect(harness.compactOptions).toBeDefined()
  })

  it('does not compact or prompt when plan selection fails', async () => {
    const harness = createHarness({
      branch: [messageEntry('user', 'make a plan')]
    })

    await harness.run()

    expect(harness.sequence).toEqual(['wait', 'branch'])
    expect(harness.sentMessages).toEqual([])
    expect(harness.notifications.at(-1)).toEqual({
      message:
        'Cutover failed: The current session branch has no assistant response.',
      type: 'error'
    })
  })

  it('does not compact or prompt when writing fails', async () => {
    const harness = createHarness({
      writePlan: async () => {
        throw new Error('disk full')
      }
    })

    await harness.run()

    expect(harness.sequence).toEqual(['wait', 'branch'])
    expect(harness.compactOptions).toBeUndefined()
    expect(harness.sentMessages).toEqual([])
    expect(harness.notifications.at(-1)).toEqual({
      message: 'Cutover failed: disk full.',
      type: 'error'
    })
  })

  it('keeps the saved plan and does not prompt when compaction fails', async () => {
    const harness = createHarness()
    await harness.run()

    harness.compactOptions?.onError?.(new Error('model unavailable'))

    expect(harness.sentMessages).toEqual([])
    expect(harness.notifications.at(-1)).toEqual({
      message:
        'Cutover could not compact the session: model unavailable. The plan remains at /tmp/pi-cutover-test/plan.md.',
      type: 'error'
    })
  })

  it('rejects another cutover until the active one completes', async () => {
    const harness = createHarness()

    await harness.run()
    await harness.run()

    expect(harness.sequence.filter((step) => step === 'compact')).toHaveLength(
      1
    )
    expect(harness.notifications.at(-1)).toEqual({
      message: 'A cutover is already in progress.',
      type: 'warning'
    })

    harness.compactOptions?.onComplete?.({} as never)
    await harness.run()

    expect(harness.sequence.filter((step) => step === 'compact')).toHaveLength(
      2
    )
  })

  it('resets the in-progress guard after compaction failure', async () => {
    const harness = createHarness()

    await harness.run()
    harness.compactOptions?.onError?.(new Error('failed'))
    await harness.run()

    expect(harness.sequence.filter((step) => step === 'compact')).toHaveLength(
      2
    )
  })

  it('reports implementation dispatch errors and permits retry', async () => {
    const harness = createHarness({ sendError: new Error('session closed') })

    await harness.run()
    harness.compactOptions?.onComplete?.({} as never)
    await harness.run()

    expect(harness.notifications).toContainEqual({
      message:
        'Compaction completed, but implementation could not start: session closed. The plan remains at /tmp/pi-cutover-test/plan.md.',
      type: 'error'
    })
    expect(harness.sequence.filter((step) => step === 'compact')).toHaveLength(
      2
    )
  })

  it('rejects command arguments without starting the workflow', async () => {
    const harness = createHarness()

    await harness.run('now')

    expect(harness.sequence).toEqual([])
    expect(harness.notifications).toEqual([
      { message: 'Usage: /cutover', type: 'warning' }
    ])
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
