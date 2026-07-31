import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import noiceChangelogExtension, {
  createConversationCheckpoint,
  generateProse
} from '../extensions/changelog/index.ts'

const RESULT_MESSAGE_TYPE = 'noice-changelog-commit-result'

test('prose generation reuses the active conversation and keeps tools read-only', async () => {
  const source = await readFile(
    new URL('../extensions/changelog/index.ts', import.meta.url),
    'utf8'
  )
  const prompt = await readFile(
    new URL('../extensions/changelog/prose-prompt.md', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(source, /completeSimple\(/)
  assert.match(source, /triggerTurn: true/)
  assert.match(source, /deliverAs: 'followUp'/)
  assert.match(source, /ctx\.navigateTree\(sourceLeafId/)
  assert.match(source, /pi\.on\('tool_call'/)
  assert.match(source, /stopReason !== 'stop'/)
  assert.doesNotMatch(source, /running deterministically/i)
  assert.doesNotMatch(source, /if \(!auth\.apiKey\)/)
  for (const key of [
    'stageChangeIds',
    'ignoreChangeIds',
    'commitType',
    'commitMessage',
    'prType',
    'prHeadline',
    'summary',
    'publicSummary',
    'context'
  ]) {
    assert.ok(prompt.includes(`\`${key}\``))
  }
})

test('conversation checkpoint preserves navigation-safe state entries', () => {
  let leaf = 'thinking-level-entry'
  const entries = new Map([
    [leaf, { type: 'thinking_level_change', thinkingLevel: 'high' }]
  ])
  const pi = {
    appendEntry(customType) {
      leaf = 'checkpoint-entry'
      entries.set(leaf, { type: 'custom', customType })
    }
  }
  const ctx = {
    sessionManager: {
      getLeafId: () => leaf,
      getEntry: (id) => entries.get(id)
    }
  }

  assert.equal(createConversationCheckpoint(pi, ctx), 'checkpoint-entry')
  assert.equal(
    entries.get('thinking-level-entry').thinkingLevel,
    'high',
    'checkpointing must retain preceding model and thinking state'
  )
})

test('prose turn branches from and returns to the active conversation', async () => {
  const handlers = new Map()
  const sent = []
  const navigated = []
  let leaf = 'source-leaf'
  let toolBlock
  let streamedContent
  const proseJson = JSON.stringify({
    stageChangeIds: [],
    ignoreChangeIds: [],
    commitType: 'internal',
    commitMessage: 'internal: reuse conversation context',
    prType: 'internal',
    prHeadline: 'reuse conversation context',
    summary: ['Reuse the active conversation.'],
    publicSummary: 'None.',
    context: ['Preserves the provider prompt cache.']
  })
  const branch = [
    {
      id: 'source-leaf',
      type: 'message',
      message: { role: 'assistant', stopReason: 'stop', content: [] }
    }
  ]
  const pi = {
    on(event, handler) {
      handlers.set(event, handler)
    },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage(message, options) {
      sent.push({ message, options })
      leaf = 'prose-leaf'
      toolBlock = handlers.get('tool_call')?.({
        toolName: 'bash',
        input: { command: 'git status' }
      })
      branch.push(
        {
          id: 'prompt-leaf',
          type: 'custom_message',
          customType: message.customType
        },
        {
          id: 'retry-error',
          type: 'message',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'transient error',
            content: []
          }
        },
        {
          id: 'prose-leaf',
          type: 'message',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: proseJson }]
          }
        }
      )
      streamedContent = [{ type: 'text', text: proseJson }]
      const streamedMessage = {
        role: 'assistant',
        stopReason: 'stop',
        content: streamedContent
      }
      handlers.get('message_start')?.({ message: streamedMessage })
      handlers.get('message_update')?.({
        message: streamedMessage,
        assistantMessageEvent: {
          type: 'text_end',
          contentIndex: 0,
          content: proseJson,
          partial: streamedMessage
        }
      })
      handlers.get('message_end')?.({ message: streamedMessage })
      queueMicrotask(() => handlers.get('agent_settled')?.({}))
    }
  }
  noiceChangelogExtension(pi)
  const ctx = {
    model: {},
    isIdle: () => true,
    waitForIdle: async () => {},
    sessionManager: {
      getLeafId: () => leaf,
      getBranch: () => branch
    },
    async navigateTree(target) {
      navigated.push(target)
      leaf = target
      return { cancelled: false }
    }
  }

  const prose = await generateProse(
    pi,
    ctx,
    {
      mode: 'normal',
      selectedChangeType: 'internal',
      userContext: 'reuse context',
      changes: [],
      status: ' M file.ts',
      diff: 'diff',
      untrackedMaterial: '',
      commits: '',
      existingPr: null,
      stackedBasePr: null,
      baseBranch: 'main',
      packageScope: 'changelog'
    },
    'source-leaf'
  )

  assert.equal(prose.commitMessage, 'internal: reuse conversation context')
  assert.deepEqual(sent[0].options, {
    triggerTurn: true,
    deliverAs: 'followUp'
  })
  assert.equal(sent[0].message.display, false)
  assert.equal(streamedContent[0].text, '')
  assert.equal(toolBlock.block, true)
  assert.deepEqual(navigated, ['source-leaf'])
  assert.equal(
    handlers.get('tool_call')?.({
      toolName: 'bash',
      input: { command: 'git status' }
    }),
    undefined,
    'tool blocking must be cleared after returning to the source leaf'
  )
})

function result(stdout = '', code = 0, stderr = '') {
  return { stdout, stderr, code, killed: false }
}

test('/commit selects immediately, waits for idle, and does not trigger an agent turn', async () => {
  const events = []
  const notifications = []
  const sentMessages = []
  const widgets = []
  let command
  let idle = false
  let idleWaiters = []

  const ctx = {
    mode: 'json',
    cwd: '/repo',
    model: undefined,
    modelRegistry: {},
    isIdle: () => idle,
    waitForIdle() {
      events.push('waitForIdle')
      if (idle) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    async exec(commandName, args) {
      events.push(`${commandName} ${args.join(' ')}`)
      const commandLine = `${commandName} ${args.join(' ')}`
      if (commandLine === 'git branch --show-current') return result('main\n')
      if (commandLine.startsWith('git status ')) return result('')
      if (commandLine === 'git ls-files --others --exclude-standard -z')
        return result('')
      if (commandLine.startsWith('gh repo view ')) {
        return result(
          JSON.stringify({
            nameWithOwner: 'owner/repo',
            defaultBranchRef: { name: 'main' }
          })
        )
      }
      if (commandLine.startsWith('gh pr list ')) return result('[]')
      if (commandLine.startsWith('git config --get ')) return result('', 1)
      if (commandLine === 'git fetch --prune origin') return result('')
      if (
        commandLine === 'git show-ref --verify --quiet refs/remotes/origin/main'
      )
        return result('')
      if (commandLine === 'git rev-parse --verify origin/main')
        return result('abc')
      if (commandLine === 'git rev-parse HEAD') return result('abc')
      if (commandLine.startsWith('git rev-list --count ')) return result('0\n')
      if (commandLine.startsWith('git diff ')) return result('')
      if (commandLine.startsWith('git log ')) return result('')
      if (commandLine === 'git rev-parse --show-toplevel')
        return result('/repo\n')
      throw new Error(`unexpected command: ${commandLine}`)
    },
    ui: {
      async select() {
        events.push('select')
        return 'fix - User-facing bug fix'
      },
      notify(message, type) {
        notifications.push({ message, type })
      },
      setWidget(_key, content) {
        widgets.push(content)
      }
    }
  }
  const pi = {
    on() {},
    registerMessageRenderer() {},
    registerCommand(name, registered) {
      if (name === 'commit') command = registered
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options })
    },
    exec: ctx.exec.bind(ctx),
    getThinkingLevel() {
      return 'high'
    }
  }

  noiceChangelogExtension(pi)
  const pending = command.handler('', ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events[0], 'select')
  assert.ok(
    notifications.some(({ message }) =>
      message.includes('waiting for the current agent turn')
    )
  )
  assert.equal(sentMessages.length, 0)

  idle = true
  for (const resolve of idleWaiters.splice(0)) resolve()
  await pending

  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].message.customType, RESULT_MESSAGE_TYPE)
  assert.equal(sentMessages[0].options, undefined)
  assert.equal(sentMessages[0].message.display, false)
  assert.match(sentMessages[0].message.content, /^status: no_changes/m)
  assert.doesNotMatch(sentMessages[0].message.content, /activity:/)
  assert.doesNotMatch(
    sentMessages[0].message.content,
    /Inspecting Git and GitHub state/
  )
  assert.doesNotMatch(sentMessages[0].message.content, /worker branch/i)
  const renderedProgress = widgets.filter(Array.isArray).flat().join('\n')
  assert.match(renderedProgress, /Finding repository root/)
  assert.match(renderedProgress, /No changes to commit/)
})

test('/commit keeps its duplicate guard through asynchronous startup', async () => {
  const notifications = []
  let command
  let releaseIdle
  const idlePromise = new Promise((resolve) => (releaseIdle = resolve))
  let firstWait = true
  const ctx = {
    mode: 'json',
    cwd: '/repo',
    model: undefined,
    modelRegistry: {},
    isIdle: () => !firstWait,
    waitForIdle() {
      if (firstWait) {
        firstWait = false
        return idlePromise
      }
      return Promise.resolve()
    },
    async exec(commandName, args) {
      const line = `${commandName} ${args.join(' ')}`
      if (line === 'git rev-parse --show-toplevel') return result('/repo')
      if (line === 'git branch --show-current') return result('main')
      if (line.startsWith('git status ')) return result('')
      if (line === 'git ls-files --others --exclude-standard -z')
        return result('')
      if (line.startsWith('gh repo view '))
        return result(
          JSON.stringify({
            nameWithOwner: 'o/r',
            defaultBranchRef: { name: 'main' }
          })
        )
      if (line.startsWith('gh pr list ')) return result('[]')
      if (line.startsWith('git config --get ')) return result('', 1)
      if (line === 'git fetch --prune origin') return result('')
      if (line === 'git show-ref --verify --quiet refs/remotes/origin/main')
        return result('')
      if (line === 'git rev-parse --verify origin/main') return result('abc')
      if (line === 'git rev-parse HEAD') return result('abc')
      if (line.startsWith('git rev-list --count ')) return result('0')
      if (line.startsWith('git diff ') || line.startsWith('git log '))
        return result('')
      throw new Error(line)
    },
    ui: {
      async select() {
        throw new Error('explicit type must not select')
      },
      notify(message, type) {
        notifications.push({ message, type })
      },
      setWidget() {}
    }
  }
  const pi = {
    on() {},
    registerMessageRenderer() {},
    registerCommand(name, value) {
      if (name === 'commit') command = value
    },
    sendMessage() {},
    exec: ctx.exec.bind(ctx),
    getThinkingLevel() {
      return 'high'
    }
  }
  noiceChangelogExtension(pi)

  const first = command.handler('feat first', ctx)
  await new Promise((resolve) => setImmediate(resolve))
  await command.handler('fix duplicate', ctx)
  assert.ok(
    notifications.some(
      ({ message, type }) =>
        message === 'Commit command is already active' && type === 'warning'
    )
  )
  releaseIdle()
  await first
})
