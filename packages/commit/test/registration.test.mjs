import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent'

import changelogExtension from '../../changelog/extensions/changelog/index.ts'
import piCommitExtension from '../extensions/commit/index.ts'
import { registerCommit } from '../extensions/commit/register.ts'

test('registration is idempotent across direct, composed, and separately loaded extension APIs', async () => {
  const harness = createRegistrationHarness()
  const directApi = harness.createApi()
  const changelogApi = harness.createApi()
  const copiedApi = harness.createApi()

  registerCommit(directApi)
  registerCommit(directApi)
  piCommitExtension(directApi)
  changelogExtension(changelogApi)
  const copy = await import(
    `../extensions/commit/register.ts?copy=${Date.now()}`
  )
  copy.registerCommit(copiedApi)

  assert.deepEqual(harness.commandNames, ['commit-config', 'commit'])
  assert.equal(harness.rendererTypes.length, 1)
  assert.equal(harness.handlerCount('agent_end'), 1)
  assert.equal(harness.handlerCount('context'), 1)
})

test('composition also deduplicates when the changelog adapter loads first', () => {
  const harness = createRegistrationHarness()

  changelogExtension(harness.createApi())
  piCommitExtension(harness.createApi())

  assert.deepEqual(harness.commandNames, ['commit-config', 'commit'])
  assert.equal(harness.rendererTypes.length, 1)
})

test('the real Pi loader registers one command set in either package order', async () => {
  const commitPath = fileURLToPath(
    new URL('../extensions/commit/index.ts', import.meta.url)
  )
  const changelogPath = fileURLToPath(
    new URL('../../changelog/extensions/changelog/index.ts', import.meta.url)
  )

  for (const paths of [
    [commitPath, changelogPath],
    [changelogPath, commitPath]
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
