import assert from 'node:assert/strict'
import test from 'node:test'

import noiceChangelogExtension from '../extensions/changelog/index.ts'

const PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-worker-prompt'

test('/commit keeps its duplicate guard during worker startup', async () => {
  const handlers = new Map()
  const notifications = []
  let command
  let duplicateCommit
  let promptSends = 0
  let waitCalls = 0

  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerCommand(name, registered) {
      if (name === 'commit') command = registered
    },
    registerMessageRenderer() {},
    getThinkingLevel() {
      return 'high'
    },
    setThinkingLevel() {},
    sendMessage(message) {
      if (message.customType !== PROMPT_MESSAGE_TYPE) return

      promptSends++
      for (const handler of handlers.get('agent_end') ?? []) {
        handler({
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
      }
    }
  }

  const ctx = {
    mode: 'json',
    isIdle() {
      return true
    },
    waitForIdle() {
      waitCalls++
      if (waitCalls === 2) {
        queueMicrotask(() =>
          queueMicrotask(() =>
            queueMicrotask(() => {
              duplicateCommit = command.handler('fix duplicate', ctx)
            })
          )
        )
      }
      return Promise.resolve()
    },
    sessionManager: {
      getLeafId() {
        return 'leaf'
      }
    },
    async navigateTree() {
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

  noiceChangelogExtension(pi)
  assert.ok(command, '/commit command should be registered')

  await command.handler('feat first', ctx)
  for (let attempt = 0; attempt < 20 && !duplicateCommit; attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.ok(duplicateCommit, 'transition duplicate should have been scheduled')
  await duplicateCommit

  assert.equal(promptSends, 1, 'only one commit worker should start')
  assert.ok(
    notifications.some(
      ({ message, type }) =>
        message === 'Commit command is already active' && type === 'warning'
    )
  )
})
