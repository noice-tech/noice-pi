import assert from 'node:assert/strict'
import test from 'node:test'

import piCommitExtension from '../extensions/commit/index.ts'

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

  piCommitExtension(pi)
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

test('/commit queues user input until it returns to the source branch', async () => {
  const handlers = new Map()
  const notifications = []
  const sentUserMessages = []
  let command
  let leafId = 'source-leaf'
  let workerStartedResolve
  const workerStarted = new Promise((resolve) => {
    workerStartedResolve = resolve
  })

  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerCommand(name, registered) {
      if (name === 'commit') command = registered
    },
    registerMessageRenderer() {},
    sendMessage(message) {
      if (message.customType === PROMPT_MESSAGE_TYPE) {
        leafId = 'worker-leaf'
        workerStartedResolve()
      }
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options })
    }
  }

  const ctx = {
    mode: 'json',
    isIdle() {
      return true
    },
    waitForIdle() {
      return Promise.resolve()
    },
    sessionManager: {
      getLeafId() {
        return leafId
      }
    },
    async navigateTree(targetLeafId) {
      leafId = targetLeafId
      return { cancelled: false }
    },
    ui: {
      async select() {
        throw new Error('explicit change types should not open the selector')
      },
      notify(message, type) {
        notifications.push({ message, type })
      },
      setWidget() {}
    }
  }

  piCommitExtension(pi)
  assert.ok(command, '/commit command should be registered')

  const commandPromise = command.handler('fix queue user input', ctx)
  await workerStarted

  const image = { type: 'image', data: 'image-data', mimeType: 'image/png' }
  const firstResult = await handlers.get('input')[0](
    {
      text: 'First queued request',
      images: [image],
      source: 'interactive',
      streamingBehavior: 'steer'
    },
    ctx
  )
  const secondResult = await handlers.get('input')[0](
    {
      text: 'Second queued request',
      source: 'interactive',
      streamingBehavior: 'followUp'
    },
    ctx
  )

  assert.deepEqual(firstResult, { action: 'handled' })
  assert.deepEqual(secondResult, { action: 'handled' })
  assert.deepEqual(sentUserMessages, [])
  assert.equal(leafId, 'worker-leaf')

  for (const handler of handlers.get('agent_end') ?? []) {
    await handler({
      messages: [
        { customType: PROMPT_MESSAGE_TYPE },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'status: committed' }]
        }
      ]
    })
  }
  await commandPromise

  assert.equal(leafId, 'source-leaf')
  assert.deepEqual(sentUserMessages, [
    {
      content: [{ type: 'text', text: 'First queued request' }, image],
      options: undefined
    }
  ])
  assert.ok(
    notifications.some(({ message }) =>
      message.includes('releasing 2 queued messages')
    )
  )

  for (const handler of handlers.get('agent_start') ?? []) {
    await handler({}, ctx)
  }
  assert.deepEqual(sentUserMessages, [
    {
      content: [{ type: 'text', text: 'First queued request' }, image],
      options: undefined
    },
    {
      content: 'Second queued request',
      options: { deliverAs: 'followUp' }
    }
  ])
})
