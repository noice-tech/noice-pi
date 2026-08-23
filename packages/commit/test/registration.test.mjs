import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createEventBus,
  discoverAndLoadExtensions
} from '@earendil-works/pi-coding-agent'

import { registerCommit } from '../extensions/commit/register.ts'

test('the real Pi loader registers one command set with native package composition in either order', async () => {
  const commitPath = fileURLToPath(
    new URL('../extensions/commit/index.ts', import.meta.url)
  )
  const composedCommitPath = fileURLToPath(
    new URL(
      '../../changelog/node_modules/@noice-tech/pi-commit/extensions/commit/index.ts',
      import.meta.url
    )
  )

  for (const paths of [
    [commitPath, composedCommitPath],
    [composedCommitPath, commitPath]
  ]) {
    const loaded = await discoverAndLoadExtensions(paths, process.cwd())
    assert.deepEqual(loaded.errors, [])
    assert.deepEqual(
      loaded.extensions.flatMap((extension) => [...extension.commands.keys()]),
      ['commit']
    )
  }
})

test('shutdown clears ownership so a fresh extension runtime can register', () => {
  const harness = createRegistrationHarness()
  const firstApi = harness.createApi()
  registerCommit(firstApi)

  for (const handler of harness.handlers.get('session_shutdown') ?? []) {
    handler({ reason: 'reload' }, {})
  }

  registerCommit(harness.createApi())
  assert.deepEqual(harness.commandNames, ['commit', 'commit'])
})

test('an unrelated commit command does not suppress pi-commit', () => {
  const harness = createRegistrationHarness()
  const competitorApi = harness.createApi()
  const commitApi = harness.createApi()
  competitorApi.registerCommand('commit', { description: 'competitor' })

  registerCommit(commitApi)

  assert.equal(
    harness.commandNames.filter((name) => name === 'commit').length,
    2
  )
})

function createRegistrationHarness() {
  const handlers = new Map()
  const eventBus = createEventBus()
  const commandNames = []

  return {
    handlers,
    commandNames,
    createApi() {
      return {
        events: eventBus,
        on(name, handler) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler])
        },
        registerCommand(name) {
          commandNames.push(name)
        },
        registerMessageRenderer() {}
      }
    }
  }
}
