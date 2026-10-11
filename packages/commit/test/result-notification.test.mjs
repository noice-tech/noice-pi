import assert from 'node:assert/strict'
import test from 'node:test'

import piCommitExtension from '../extensions/commit/index.ts'

const PROMPT_TYPE = 'noice-changelog-commit-worker-prompt'
const RESULT_TYPE = 'noice-changelog-commit-result'

for (const [name, text, error, expectedStatus] of [
  [
    'success',
    'The user committed and pushed the changes.\n\nstatus: committed',
    undefined,
    'ok'
  ],
  [
    'partial failure',
    'The user committed the changes, but the push failed.\n\nstatus: failed',
    undefined,
    'failed'
  ],
  ['cancellation', '', undefined, 'cancelled'],
  [
    'provider failure',
    'The user created branch fix/partial.',
    'provider unavailable',
    'failed'
  ],
  ['extension failure', '', 'worker startup failed', 'failed']
]) {
  test(`${name} is reported once in the result card, not repeated in notifications`, async () => {
    const handlers = new Map()
    const notifications = []
    const results = []
    let command
    let leafId = 'source'
    const pi = {
      on(name, handler) {
        handlers.set(name, handler)
      },
      registerCommand(_name, registered) {
        command = registered
      },
      registerMessageRenderer() {},
      appendEntry() {},
      sendMessage(message) {
        if (message.customType === RESULT_TYPE) {
          results.push(message)
          leafId = 'result'
          return
        }
        assert.equal(message.customType, PROMPT_TYPE)
        if (name === 'extension failure') throw new Error(error)
        leafId = 'worker'
        queueMicrotask(() =>
          handlers.get('agent_end')({
            messages: [
              { customType: PROMPT_TYPE },
              {
                role: 'assistant',
                content: [{ type: 'text', text }],
                stopReason: error ? 'error' : 'stop',
                errorMessage: error
              }
            ]
          })
        )
      }
    }
    const ctx = {
      mode: 'json',
      isIdle: () => true,
      waitForIdle: async () => {},
      sessionManager: { getLeafId: () => leafId },
      async navigateTree(target) {
        leafId = target
        return { cancelled: false }
      },
      ui: {
        notify(message, type) {
          notifications.push({ message, type })
        },
        setWidget() {}
      }
    }
    piCommitExtension(pi)
    await command.handler('fix retain outcomes', ctx)

    assert.equal(results.length, 1)
    assert.equal(results[0].display, true)
    assert.equal(results[0].details.status, expectedStatus)
    if (text) assert.ok(results[0].content.includes(text))
    if (error) assert.ok(results[0].content.includes(error))
    assert.deepEqual(
      notifications,
      [{ message: 'Starting commit worker (fix)', type: 'info' }],
      'progress notifications remain, but completion details appear only in the result card'
    )
    assert.equal(leafId, 'result')
  })
}
