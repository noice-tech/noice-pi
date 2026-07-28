import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import {
  createCutover,
  createTemporaryPlanFile,
  planRequest,
  verifyPlanWritten
} from '../extensions/cutover/index.js'

type CommandHandler = (
  args: string,
  context: ExtensionCommandContext
) => void | Promise<void>
type CompactOptions = NonNullable<
  Parameters<ExtensionCommandContext['compact']>[0]
>
type AgentSettledHandler = (
  event: unknown,
  context: ExtensionContext
) => void | Promise<void>

interface HarnessOptions {
  idle?: boolean
  createPlanFile?: () => Promise<string>
  verifyPlan?: (path: string) => Promise<void>
  waitForIdle?: () => Promise<void>
  sendError?: (content: string, call: number) => Error | undefined
}

function createHarness(options: HarnessOptions = {}) {
  let idle = options.idle ?? true
  let compactOptions: CompactOptions | undefined
  let agentSettled: AgentSettledHandler | undefined
  let sendCall = 0
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
  const createdPaths: string[] = []
  const verifiedPaths: string[] = []
  const createPlanFile =
    options.createPlanFile ??
    (async () => {
      sequence.push('create-file')
      createdPaths.push('/tmp/pi-cutover-test/plan.md')
      return '/tmp/pi-cutover-test/plan.md'
    })
  const verifyPlan =
    options.verifyPlan ??
    (async (path: string) => {
      sequence.push('verify')
      verifiedPaths.push(path)
    })

  const pi = {
    on(event: string, handler: AgentSettledHandler) {
      if (event === 'agent_settled') agentSettled = handler
    },
    registerCommand(
      name: string,
      command: { description?: string; handler: CommandHandler }
    ) {
      commands.set(name, command)
    },
    sendUserMessage(content: string) {
      sendCall += 1
      sequence.push('send')
      const error = options.sendError?.(content, sendCall)
      if (error) throw error
      sentMessages.push(content)
      idle = false
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
        throw new Error('Cutover must not inspect session messages')
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
      idle = true
    }
  } as unknown as ExtensionCommandContext

  createCutover({ createPlanFile, verifyPlan })(pi)

  return {
    commands,
    context,
    notifications,
    sentMessages,
    sequence,
    createdPaths,
    verifiedPaths,
    get compactOptions() {
      return compactOptions
    },
    async run(args = '') {
      const command = commands.get('cutover')
      if (!command) throw new Error('/cutover was not registered')
      await command.handler(args, context)
    },
    async settle() {
      sequence.push('settle')
      idle = true
      await agentSettled?.({}, context)
    }
  }
}

describe('temporary plan file', () => {
  it('creates unique empty Markdown files in OS temporary directories', async () => {
    const paths: string[] = []

    try {
      paths.push(await createTemporaryPlanFile())
      paths.push(await createTemporaryPlanFile())

      expect(paths[0]).not.toBe(paths[1])
      for (const path of paths) {
        expect(path).toBe(join(dirname(path), 'plan.md'))
        expect(dirname(path)).toMatch(
          new RegExp(`^${escapeRegExp(join(tmpdir(), 'pi-cutover-'))}`)
        )
        expect(await readFile(path, 'utf8')).toBe('')
      }
    } finally {
      await Promise.all(
        paths.map((path) => rm(dirname(path), { recursive: true, force: true }))
      )
    }
  })

  it('verifies that the agent replaced the empty file with a plan', async () => {
    const planPath = await createTemporaryPlanFile()

    try {
      await expect(verifyPlanWritten(planPath)).rejects.toThrow(
        `The agent did not write a plan to ${planPath}`
      )

      await writeFile(planPath, '# Plan\n', 'utf8')
      await expect(verifyPlanWritten(planPath)).resolves.toBeUndefined()
    } finally {
      await rm(dirname(planPath), { recursive: true, force: true })
    }
  })
})

describe('plan request', () => {
  it('asks the agent to overwrite the known file without returning its path', () => {
    expect(planRequest('/tmp/cutover/plan.md')).toBe(
      'Write a complete implementation plan for the work we have been discussing to /tmp/cutover/plan.md. The empty file has already been created for you. Use your file-writing tools to replace its contents with the plan. Do not implement the plan yet. Once the plan has been written, stop.'
    )
  })
})

describe('/cutover', () => {
  it('registers only the cutover command with a useful description', () => {
    const harness = createHarness()

    expect([...harness.commands]).toEqual([
      [
        'cutover',
        expect.objectContaining({
          description: 'Write a plan to a temp file, compact, and implement it'
        })
      ]
    ])
  })

  it('creates a file, asks the agent to write it, then verifies and compacts', async () => {
    const harness = createHarness()

    await harness.run()

    expect(harness.sequence).toEqual(['wait', 'create-file', 'send'])
    expect(harness.sentMessages).toEqual([
      planRequest('/tmp/pi-cutover-test/plan.md')
    ])
    expect(harness.compactOptions).toBeUndefined()

    await harness.settle()

    expect(harness.sequence).toEqual([
      'wait',
      'create-file',
      'send',
      'settle',
      'verify',
      'compact'
    ])
    expect(harness.createdPaths).toEqual(['/tmp/pi-cutover-test/plan.md'])
    expect(harness.verifiedPaths).toEqual(['/tmp/pi-cutover-test/plan.md'])
  })

  it('never inspects the planning response', async () => {
    const harness = createHarness()

    await harness.run()
    await harness.settle()

    expect(harness.sequence).not.toContain('branch')
    expect(harness.compactOptions).toBeDefined()
  })

  it('waits for a busy turn before asking for the plan', async () => {
    const harness = createHarness({ idle: false })

    await harness.run()

    expect(harness.sequence).toEqual(['wait', 'create-file', 'send'])
    expect(harness.notifications[0]).toEqual({
      message: 'Waiting for the current turn before cutting over…',
      type: 'info'
    })
  })

  it('starts implementation only after successful compaction', async () => {
    const harness = createHarness()

    await harness.run()
    await harness.settle()
    expect(harness.sentMessages).toEqual([
      planRequest('/tmp/pi-cutover-test/plan.md')
    ])

    harness.compactOptions?.onComplete?.({} as never)

    expect(harness.sentMessages).toEqual([
      planRequest('/tmp/pi-cutover-test/plan.md'),
      'Implement the plan from /tmp/pi-cutover-test/plan.md'
    ])
  })

  it('rejects another cutover while the planning turn is running', async () => {
    const harness = createHarness()

    await harness.run()
    await harness.run()

    expect(harness.notifications.at(-1)).toEqual({
      message: 'A cutover is already in progress.',
      type: 'warning'
    })
    expect(harness.compactOptions).toBeUndefined()
  })

  it('does not compact when the planning turn cannot start', async () => {
    const harness = createHarness({
      sendError: (_content, call) =>
        call === 1 ? new Error('session closed') : undefined
    })

    await harness.run()
    await harness.settle()

    expect(harness.sequence).toEqual(['wait', 'create-file', 'send', 'settle'])
    expect(harness.compactOptions).toBeUndefined()
    expect(harness.notifications.at(-1)).toEqual({
      message:
        'Cutover failed: session closed. The plan file remains at /tmp/pi-cutover-test/plan.md.',
      type: 'error'
    })
  })

  it('does not compact when the agent leaves the plan empty', async () => {
    const harness = createHarness({
      verifyPlan: async (path) => {
        throw new Error(`The agent did not write a plan to ${path}`)
      }
    })

    await harness.run()
    await harness.settle()

    expect(harness.sequence).not.toContain('compact')
    expect(harness.notifications.at(-1)).toEqual({
      message:
        'Cutover failed: The agent did not write a plan to /tmp/pi-cutover-test/plan.md. The plan file remains at /tmp/pi-cutover-test/plan.md.',
      type: 'error'
    })
  })

  it('keeps the written plan and does not implement when compaction fails', async () => {
    const harness = createHarness()
    await harness.run()
    await harness.settle()

    harness.compactOptions?.onError?.(new Error('model unavailable'))

    expect(harness.sentMessages).toEqual([
      planRequest('/tmp/pi-cutover-test/plan.md')
    ])
    expect(harness.notifications.at(-1)).toEqual({
      message:
        'Cutover could not compact the session: model unavailable. The plan remains at /tmp/pi-cutover-test/plan.md.',
      type: 'error'
    })
  })

  it('rejects another cutover until compaction completes', async () => {
    const harness = createHarness()

    await harness.run()
    await harness.settle()
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
    await harness.settle()

    expect(harness.sequence.filter((step) => step === 'compact')).toHaveLength(
      2
    )
  })

  it('resets the in-progress guard after compaction failure', async () => {
    const harness = createHarness()

    await harness.run()
    await harness.settle()
    harness.compactOptions?.onError?.(new Error('failed'))
    await harness.run()
    await harness.settle()

    expect(harness.sequence.filter((step) => step === 'compact')).toHaveLength(
      2
    )
  })

  it('reports implementation dispatch errors and permits retry', async () => {
    const harness = createHarness({
      sendError: (content) =>
        content.startsWith('Implement')
          ? new Error('session closed')
          : undefined
    })

    await harness.run()
    await harness.settle()
    harness.compactOptions?.onComplete?.({} as never)
    await harness.run()
    await harness.settle()

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
