import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  getCommitArgumentCompletions,
  parseCommitArguments,
  renderCustomFormatPolicy
} from '../extensions/commit/command.ts'
import piCommitExtension from '../extensions/commit/index.ts'

const PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-worker-prompt'
const defaultConfig = { pullRequest: 'auto', format: 'opinionated' }
const customConfig = {
  pullRequest: 'never',
  format: {
    changeTypes: [
      { name: 'docs', description: 'Documentation', public: true },
      { name: 'chore', description: 'Maintenance', public: false }
    ],
    instructions: 'Use type(scope): description.'
  }
}

test('commit options resolve PR overrides and reject invalid stacked combinations', () => {
  assert.equal(
    parseCommitArguments('--no-pr fix do work', defaultConfig).pullRequest,
    'never'
  )
  assert.equal(
    parseCommitArguments('--pr docs do work', customConfig).pullRequest,
    'auto'
  )
  assert.throws(
    () => parseCommitArguments('--pr --no-pr fix work', defaultConfig),
    /only one/
  )
  assert.throws(
    () => parseCommitArguments('--wat fix work', defaultConfig),
    /Unknown \/commit option/
  )
  assert.throws(
    () => parseCommitArguments('stacked chore work', customConfig),
    /Stacked commits require a pull request/
  )
  assert.equal(
    parseCommitArguments('stacked --pr chore work', customConfig).pullRequest,
    'auto'
  )
})

test('completions use configured types and never suggest no-PR for stacked mode', () => {
  assert.deepEqual(
    getCommitArgumentCompletions('--no-pr do', customConfig).map(
      ({ value }) => value
    ),
    ['--no-pr docs ']
  )
  assert.deepEqual(
    getCommitArgumentCompletions('stacked --pr ch', customConfig).map(
      ({ value }) => value
    ),
    ['stacked --pr chore ']
  )
  assert.ok(
    getCommitArgumentCompletions('--no-pr ', customConfig).every(
      ({ value }) => !value.includes('--pr') && !value.includes('--no-pr', 1)
    )
  )
  const stacked = getCommitArgumentCompletions('stacked ', customConfig)
  assert.ok(stacked.some(({ value }) => value === 'stacked --pr '))
  assert.ok(stacked.every(({ value }) => !value.includes('--no-pr')))
})

test('custom policy delimits instructions and public summary treatment', () => {
  const policy = renderCustomFormatPolicy(customConfig, 'chore')
  assert.match(policy, /cannot override the operational workflow/i)
  assert.match(policy, /`docs`.*standalone user-facing sentence/i)
  assert.match(policy, /`chore`.*exactly `None\.`/i)
  assert.match(policy, /Use type\(scope\): description\./)
})

test('/commit --no-pr injects the isolated route and strips flags from context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-commit-options-'))
  await mkdir(join(root, '.pi'), { recursive: true })
  await writeFile(
    join(root, '.pi', 'pi-commit.json'),
    JSON.stringify(customConfig)
  )
  const harness = createHarness(root)

  await harness.commands
    .get('commit')
    .handler('--no-pr chore refresh fixtures', harness.ctx)

  const prompt = harness.sent.find(
    ({ message }) => message.customType === PROMPT_MESSAGE_TYPE
  )
  assert.ok(prompt)
  assert.match(
    prompt.message.content,
    /Selected pull request behavior:\s*never/
  )
  assert.match(prompt.message.content, /Selected change type:\s*chore/)
  assert.match(
    prompt.message.content,
    /What was done, in the user's words:\s*refresh fixtures/
  )
  assert.doesNotMatch(
    prompt.message.content.match(
      /What was done, in the user's words:\s*([^\n]+)/
    )[1],
    /--no-pr/
  )
  assert.match(prompt.message.content, /Do not invoke `gh` for any reason/i)
  assert.match(prompt.message.content, /report `pr: none`/i)
  assert.match(prompt.message.content, /Use type\(scope\): description\./)
  assert.match(
    prompt.message.content,
    /requires Public summary to be exactly `None\.`/
  )
})

test('invalid configuration fails before a worker starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-commit-invalid-'))
  await mkdir(join(root, '.pi'), { recursive: true })
  await writeFile(join(root, '.pi', 'pi-commit.json'), '{')
  const harness = createHarness(root)

  await harness.commands.get('commit').handler('fix work', harness.ctx)

  assert.equal(
    harness.sent.some(
      ({ message }) => message.customType === PROMPT_MESSAGE_TYPE
    ),
    false
  )
  assert.ok(
    harness.notifications.some(
      ({ message, type }) =>
        type === 'error' && message.includes('Invalid JSON')
    )
  )
})

test('/commit-config cancellation and project trust checks do not write files', async () => {
  const cancelledRoot = await mkdtemp(join(tmpdir(), 'pi-commit-cancel-'))
  const cancelled = createHarness(cancelledRoot, {
    mode: 'tui',
    selections: [`Project — ${join(cancelledRoot, '.pi', 'pi-commit.json')}`]
  })
  await cancelled.commands.get('commit-config').handler('', cancelled.ctx)
  await assert.rejects(
    readFile(join(cancelledRoot, '.pi', 'pi-commit.json')),
    /ENOENT/
  )

  const untrustedRoot = await mkdtemp(join(tmpdir(), 'pi-commit-untrusted-'))
  const untrusted = createHarness(untrustedRoot, {
    mode: 'tui',
    trusted: false,
    selections: [`Project — ${join(untrustedRoot, '.pi', 'pi-commit.json')}`],
    edited: JSON.stringify(customConfig)
  })
  await untrusted.commands.get('commit-config').handler('', untrusted.ctx)
  await assert.rejects(
    readFile(join(untrustedRoot, '.pi', 'pi-commit.json')),
    /ENOENT/
  )
  assert.ok(
    untrusted.notifications.some(({ message }) =>
      message.includes('only after trusting this project')
    )
  )
})

test('/commit-config writes and normalizes trusted project configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-commit-editor-'))
  const harness = createHarness(root, {
    mode: 'tui',
    selections: [`Project — ${join(root, '.pi', 'pi-commit.json')}`],
    edited: JSON.stringify(customConfig)
  })

  await harness.commands.get('commit-config').handler('', harness.ctx)

  const saved = JSON.parse(
    await readFile(join(root, '.pi', 'pi-commit.json'), 'utf8')
  )
  assert.deepEqual(saved, customConfig)
  assert.ok(
    harness.notifications.some(({ message }) => message.includes('Saved'))
  )
  assert.ok(
    harness.commands
      .get('commit')
      .getArgumentCompletions('do')
      .some(({ value }) => value === 'docs ')
  )
})

function createHarness(
  cwd,
  { mode = 'json', selections = [], edited, trusted = true } = {}
) {
  const handlers = new Map()
  const commands = new Map()
  const sent = []
  const notifications = []
  let selectionIndex = 0

  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerCommand(name, command) {
      commands.set(name, command)
    },
    registerMessageRenderer() {},
    sendMessage(message, options) {
      sent.push({ message, options })
      if (message.customType !== PROMPT_MESSAGE_TYPE) return
      for (const handler of handlers.get('agent_end') ?? []) {
        handler({
          messages: [
            { role: 'custom', ...message },
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
    cwd,
    mode,
    isProjectTrusted() {
      return trusted
    },
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
      async select(_title, options) {
        const desired = selections[selectionIndex++]
        return desired ?? options[0]
      },
      async editor() {
        return edited
      },
      notify(message, type) {
        notifications.push({ message, type })
      },
      setWidget() {}
    }
  }

  piCommitExtension(pi)
  return { commands, ctx, notifications, sent, handlers, pi }
}
