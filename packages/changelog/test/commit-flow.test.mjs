import assert from 'node:assert/strict'
import test from 'node:test'

import noiceChangelogExtension from '../extensions/changelog/index.ts'

const PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-worker-prompt'
const RESULT_MESSAGE_TYPE = 'noice-changelog-commit-result'

test('/commit selects immediately, then waits for the active turn', async () => {
  const events = []
  const notifications = []
  const sentMessages = []
  const thinkingLevels = []
  const handlers = new Map()
  let command
  let idle = false
  let leafId = 'source-leaf'
  let thinkingLevel = 'high'
  let idleWaiters = []

  const setIdle = (value) => {
    idle = value
    if (!idle) return

    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  const emit = (name, event) => {
    for (const handler of handlers.get(name) ?? []) handler(event)
  }

  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerCommand(name, registered) {
      if (name === 'commit') command = registered
    },
    registerMessageRenderer() {},
    getThinkingLevel() {
      return thinkingLevel
    },
    setThinkingLevel(level) {
      thinkingLevel = level
      thinkingLevels.push(level)
      events.push(`thinking:${level}`)
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options })
      events.push(`send:${message.customType}`)

      if (message.customType !== PROMPT_MESSAGE_TYPE) return

      leafId = 'worker-leaf'
      setIdle(false)
      queueMicrotask(() => {
        emit('agent_end', {
          messages: [
            {
              role: 'custom',
              customType: PROMPT_MESSAGE_TYPE,
              content: message.content
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'status: committed' }]
            }
          ]
        })
        setIdle(true)
      })
    }
  }

  const ctx = {
    mode: 'json',
    isIdle() {
      return idle
    },
    waitForIdle() {
      events.push('waitForIdle')
      if (idle) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    sessionManager: {
      getLeafId() {
        return leafId
      }
    },
    async navigateTree(targetLeafId) {
      events.push(`navigate:${targetLeafId}`)
      leafId = targetLeafId
      return { cancelled: false }
    },
    ui: {
      async select() {
        events.push('select')
        return 'fix - User-facing bug fix'
      },
      notify(message, type) {
        notifications.push({ message, type })
        events.push(`notify:${message}`)
      },
      setWidget() {}
    }
  }

  noiceChangelogExtension(pi)
  assert.ok(command, '/commit command should be registered')

  const firstCommit = command.handler('', ctx)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(events[0], 'select')
  assert.ok(events.includes('waitForIdle'))
  assert.equal(
    sentMessages.some(
      ({ message }) => message.customType === PROMPT_MESSAGE_TYPE
    ),
    false,
    'worker must not start while the original turn is active'
  )
  assert.ok(
    notifications.some(({ message }) =>
      message.includes('waiting for the current agent turn')
    )
  )

  await command.handler('feat duplicate', ctx)
  assert.ok(
    notifications.some(
      ({ message, type }) =>
        message === 'Commit command is already active' && type === 'warning'
    ),
    'a second command must not overwrite the pending worker waiter'
  )

  setIdle(true)
  await firstCommit

  const prompt = sentMessages.find(
    ({ message }) => message.customType === PROMPT_MESSAGE_TYPE
  )
  assert.ok(prompt, 'worker prompt should be sent after idle')
  assert.deepEqual(prompt.options, {
    triggerTurn: true,
    deliverAs: 'followUp'
  })
  assert.match(prompt.message.content, /Selected change type:\s*fix/)
  assert.deepEqual(
    thinkingLevels,
    [],
    '/commit must preserve the user-selected thinking level'
  )
  assert.equal(thinkingLevel, 'high')
  assert.ok(events.indexOf('select') < events.indexOf('waitForIdle'))
  assert.ok(
    events.indexOf('waitForIdle') <
      events.indexOf(`send:${PROMPT_MESSAGE_TYPE}`)
  )
  assert.ok(
    sentMessages.some(
      ({ message }) => message.customType === RESULT_MESSAGE_TYPE
    )
  )
})
