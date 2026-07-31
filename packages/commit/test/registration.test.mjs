import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent'

import piCommitExtension from '../extensions/commit/index.ts'
import { registerCommit } from '../extensions/commit/register.ts'

test('registration is idempotent across direct and separately loaded extension APIs', async () => {
  const harness = createRegistrationHarness()
  const directApi = harness.createApi()
  const copiedApi = harness.createApi()

  registerCommit(directApi)
  registerCommit(directApi)
  piCommitExtension(directApi)
  const copy = await import(
    `../extensions/commit/register.ts?copy=${Date.now()}`
  )
  copy.registerCommit(copiedApi)

  assert.deepEqual(harness.commandNames, ['commit-config', 'commit'])
  assert.equal(harness.rendererTypes.length, 1)
  assert.equal(harness.handlerCount('agent_end'), 1)
  assert.equal(harness.handlerCount('context'), 1)
})

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
      ['commit-config', 'commit']
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
  assert.deepEqual(harness.commandNames, [
    'commit-config',
    'commit',
    'commit-config',
    'commit'
  ])
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
  assert.ok(harness.commandNames.includes('commit-config'))
})

function createRegistrationHarness() {
  const handlers = new Map()
  const commandNames = []
  const rendererTypes = []
  const eventBus = {}

  return {
    eventBus,
    handlers,
    commandNames,
    rendererTypes,
    createApi() {
      return {
        events: eventBus,
        on(name, handler) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler])
        },
        registerCommand(name) {
          commandNames.push(name)
        },
        registerMessageRenderer(type) {
          rendererTypes.push(type)
        }
      }
    },
    handlerCount(name) {
      return handlers.get(name)?.length ?? 0
    }
  }
}
