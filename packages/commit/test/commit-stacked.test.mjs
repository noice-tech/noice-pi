import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import piCommitExtension from '../extensions/commit/index.ts'

const PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-worker-prompt'
const RESULT_MESSAGE_TYPE = 'noice-changelog-commit-result'

function registerCommitCommand({ selectedType = 'fix' } = {}) {
  const handlers = new Map()
  const sentMessages = []
  const selections = []
  let command

  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerCommand(name, registered) {
      if (name === 'commit') command = registered
    },
    registerMessageRenderer() {},
    sendMessage(message, options) {
      sentMessages.push({ message, options })
      if (message.customType !== PROMPT_MESSAGE_TYPE) return

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
      async select(title, options) {
        selections.push({ title, options })
        return options.find((option) => option.startsWith(selectedType))
      },
      notify() {},
      setWidget() {}
    }
  }

  piCommitExtension(pi)
  assert.ok(command, '/commit command should be registered')
  return { command, ctx, selections, sentMessages }
}

test('/commit stacked completions route through change type and context', () => {
  const { command } = registerCommitCommand()

  assert.ok(
    command
      .getArgumentCompletions('sta')
      .some(
        ({ value, label }) =>
          value === 'stacked ' && /above the current pull request/i.test(label)
      )
  )
  assert.deepEqual(
    command.getArgumentCompletions('stacked fi').map(({ value }) => value),
    ['stacked fix ']
  )
  assert.deepEqual(command.getArgumentCompletions('stacked fix child work'), [
    {
      value: 'stacked fix child work',
      label: 'What was done: "child work"'
    }
  ])
  assert.deepEqual(command.getArgumentCompletions('fix child work'), [
    {
      value: 'fix child work',
      label: 'What was done: "child work"'
    }
  ])
})

test('/commit stacked injects mode without including the token in user context', async () => {
  const { command, ctx, selections, sentMessages } = registerCommitCommand()

  await command.handler('stacked fix add child behavior', ctx)

  assert.equal(selections.length, 0)
  const prompt = sentMessages.find(
    ({ message }) => message.customType === PROMPT_MESSAGE_TYPE
  )
  assert.ok(prompt)
  assert.match(prompt.message.content, /Selected mode:\s*stacked/)
  assert.match(prompt.message.content, /Selected change type:\s*fix/)
  assert.match(
    prompt.message.content,
    /What was done, in the user's words:\s*add child behavior/
  )
  assert.deepEqual(prompt.message.details, {
    changeType: 'fix',
    mode: 'stacked',
    userContext: 'add child behavior'
  })
  assert.ok(
    sentMessages.some(
      ({ message }) =>
        message.customType === RESULT_MESSAGE_TYPE &&
        message.details.mode === 'stacked'
    )
  )
})

test('/commit stacked without a type uses the existing selector', async () => {
  const { command, ctx, selections, sentMessages } = registerCommitCommand({
    selectedType: 'improve'
  })

  await command.handler('stacked make child flow clearer', ctx)

  assert.equal(selections.length, 1)
  const prompt = sentMessages.find(
    ({ message }) => message.customType === PROMPT_MESSAGE_TYPE
  )
  assert.match(prompt.message.content, /Selected mode:\s*stacked/)
  assert.match(prompt.message.content, /Selected change type:\s*improve/)
  assert.match(
    prompt.message.content,
    /What was done, in the user's words:\s*make child flow clearer/
  )
})

test('stacked worker prompt owns the complete gh stack protocol', async () => {
  const prompt = await readFile(
    new URL('../extensions/commit/worker-prompt.md', import.meta.url),
    'utf8'
  )

  assert.match(prompt, /Selected mode:\s*\{\{mode\}\}/)
  assert.match(
    prompt,
    /normal[^\n]+pull request behavior `auto`[^\n]+normal PR workflow/i
  )
  assert.match(prompt, /--state all/)
  assert.match(prompt, /headRepositoryOwner\.login[^\n]+case-insensitively/i)
  assert.match(prompt, /HEAD[^\n]+origin\/\$current_branch/)
  assert.match(prompt, /gh stack view --json/)
  assert.match(prompt, /gh stack checkout/)
  assert.match(prompt, /gh stack init --base/)
  assert.match(prompt, /gh stack add/)
  assert.match(prompt, /needsRebase: true[^\n]+valid/i)
  assert.match(prompt, /must not run `gh stack sync`/i)
  assert.match(prompt, /gh pr create[\s\S]+--base[\s\S]+--head/)
  assert.match(prompt, /never update the parent's title, body, or base/i)
  assert.match(prompt, /gh stack submit --auto/)
  assert.match(prompt, /stacks\?pull_request=\$child_pr_number/)
  assert.match(prompt, /parent PR immediately before the child PR/i)
  assert.match(prompt, /Never read or modify `\.git\/gh-stack` directly/i)
  assert.match(
    prompt,
    /Never automatically delete, close, reset, rewrite, or reuse/i
  )
})
